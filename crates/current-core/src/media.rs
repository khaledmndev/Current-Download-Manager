use crate::{Job, Status, Store};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaMode {
    #[default]
    Video,
    Audio,
    Mp3,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MediaOptions {
    pub mode: MediaMode,
    pub max_height: u32,
}
impl Default for MediaOptions {
    fn default() -> Self {
        Self {
            mode: MediaMode::Video,
            max_height: 1080,
        }
    }
}
impl MediaOptions {
    pub fn extension(&self) -> &'static str {
        match self.mode {
            MediaMode::Video => "mp4",
            MediaMode::Audio => "m4a",
            MediaMode::Mp3 => "mp3",
        }
    }
    pub fn validate(&self) -> Result<()> {
        if !(32..=8640).contains(&self.max_height) {
            bail!("Choose a supported YouTube video height.");
        }
        Ok(())
    }
}
pub fn is_youtube_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some(
            "youtube.com"
                | "www.youtube.com"
                | "m.youtube.com"
                | "music.youtube.com"
                | "youtu.be"
                | "www.youtu.be"
        )
    )
}
pub fn youtube_id(url: &Url) -> Option<String> {
    if !is_youtube_host(url)
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let id = if matches!(url.host_str(), Some("youtu.be" | "www.youtu.be")) {
        parts.first()?.to_string()
    } else if url.path() == "/watch" {
        url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned()
    } else if parts.len() == 2 && matches!(parts[0], "shorts" | "live" | "embed") {
        parts[1].to_string()
    } else {
        return None;
    };
    if id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        Some(id)
    } else {
        None
    }
}
fn find_tool(name: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(folder) = exe.parent() {
            roots.push(folder.join("media"));
            roots.push(folder.to_path_buf());
        }
    }
    // Do not embed a developer workspace path in public release binaries.
    #[cfg(debug_assertions)]
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../runtime/media"));
    if let Some(paths) = std::env::var_os("PATH") {
        roots.extend(std::env::split_paths(&paths).filter(|p| p.is_absolute()));
    }
    roots
        .into_iter()
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}
pub fn capabilities() -> Value {
    let downloader = find_tool("yt-dlp.exe").is_some();
    let merger = find_tool("ffmpeg.exe").is_some();
    let probe = find_tool("ffprobe.exe").is_some();
    let runtime = find_tool("deno.exe").is_some();
    serde_json::json!({"youtube":downloader&&merger&&probe&&runtime,"downloader":downloader,"ffmpeg":merger,"ffprobe":probe,"javascript_runtime":runtime})
}
fn process(program: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
#[cfg(windows)]
struct ProcessTree(usize);
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &Child) -> Result<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(
                    handle,
                    child
                        .raw_handle()
                        .context("Media subprocess has no process handle")?
                        as _,
                ) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error.into());
            }
            Ok(Self(handle as usize))
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}
#[cfg(not(windows))]
struct ProcessTree;
#[cfg(not(windows))]
impl ProcessTree {
    fn attach(_child: &Child) -> Result<Self> {
        Ok(Self)
    }
}

static FORMAT_REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn summarize_formats(value: &Value) -> Result<Value> {
    if value["is_live"] == true {
        bail!("Live streams are not supported in this version.");
    }
    let formats = value["formats"]
        .as_array()
        .context("This video has no downloadable formats.")?;
    let mut heights = std::collections::BTreeSet::new();
    let mut audio = false;
    for format in formats {
        if format["has_drm"] == true {
            continue;
        }
        let video_codec = format["vcodec"].as_str().unwrap_or("none");
        let audio_codec = format["acodec"].as_str().unwrap_or("none");
        audio |= audio_codec != "none";
        if video_codec != "none" {
            if let Some(height) = format["height"]
                .as_u64()
                .filter(|h| (32..=8640).contains(h))
            {
                heights.insert(height);
            }
        }
    }
    if heights.is_empty() && !audio {
        bail!("No supported video or audio formats were found.");
    }
    Ok(
        serde_json::json!({"title":value["title"].as_str().unwrap_or("YouTube video").chars().take(180).collect::<String>(),"heights":heights.into_iter().rev().collect::<Vec<_>>(),"audio_available":audio}),
    )
}

pub async fn formats(url: &str) -> Result<Value> {
    let id = youtube_id(&crate::validate_url(url)?).context("Use a single YouTube video link.")?;
    let _permit = FORMAT_REQUESTS
        .try_acquire()
        .context("Current is already checking video formats. Try again shortly.")?;
    let downloader = find_tool("yt-dlp.exe").context("Current's YouTube runtime is missing.")?;
    let runtime = find_tool("deno.exe").context("Current's JavaScript runtime is missing.")?;
    let mut command = process(&downloader);
    command
        .args([
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-exec",
            "--no-playlist",
            "--no-cache-dir",
            "--skip-download",
            "--dump-single-json",
            "--socket-timeout",
            "15",
            "--retries",
            "1",
            "--extractor-retries",
            "1",
            "--js-runtimes",
        ])
        .arg(format!("deno:{}", runtime.display()))
        .arg("--")
        .arg(format!("https://www.youtube.com/watch?v={id}"));
    let mut child = command
        .spawn()
        .context("Could not check this video's formats")?;
    let tree = ProcessTree::attach(&child)?;
    let mut stdout = child.stdout.take().unwrap().take(4 * 1024 * 1024 + 1);
    let mut stderr = child.stderr.take().unwrap().take(16 * 1024);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        tokio::join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors),
            child.wait()
        )
    })
    .await;
    drop(tree);
    let (out_result, err_result, status) = match result {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            bail!("Checking video qualities timed out. Please try again.");
        }
    };
    out_result?;
    err_result?;
    if !status?.success() {
        bail!(
            "Could not read this video's formats: {}",
            String::from_utf8_lossy(&errors)
                .chars()
                .take(400)
                .collect::<String>()
        );
    }
    if output.len() > 4 * 1024 * 1024 {
        bail!("The video format response exceeds its size limit.");
    }
    summarize_formats(&serde_json::from_slice(&output)?)
}

fn format_selector(options: &MediaOptions) -> String {
    let h = options.max_height;
    if options.mode != MediaMode::Video {
        "bestaudio/best".into()
    } else {
        format!("bv[height<={h}]+ba/b[height<={h}]")
    }
}
#[derive(Default)]
struct Progress {
    files: HashMap<String, (u64, Option<u64>)>,
    last: u64,
}
impl Progress {
    fn update(&mut self, value: &Value) -> (u64, Option<u64>, u64) {
        let file = value["file"].as_str().unwrap_or("stream").to_string();
        let downloaded = value["downloaded"].as_u64().unwrap_or(0);
        let total = value["total"].as_u64().filter(|n| *n > 0);
        self.files.insert(file, (downloaded, total));
        let done: u64 = self.files.values().map(|(n, _)| *n).sum();
        let total = if self.files.values().all(|(_, n)| n.is_some()) {
            Some(self.files.values().map(|(_, n)| n.unwrap()).sum())
        } else {
            None
        };
        let delta = done.saturating_sub(self.last);
        self.last = done;
        (done, total, delta)
    }
}
pub async fn download(
    job: &Job,
    store: Arc<Store>,
    cancel: &CancellationToken,
    bytes: Arc<AtomicU64>,
) -> Result<Option<PathBuf>> {
    let options = job
        .media
        .as_ref()
        .context("Missing YouTube media options")?;
    options.validate()?;
    let downloader = find_tool("yt-dlp.exe")
        .context("YouTube downloader is missing. Install Current's media runtime.")?;
    let ffmpeg = find_tool("ffmpeg.exe").context(
        "FFmpeg is required for YouTube video/audio merging. Install FFmpeg and restart Current.",
    )?;
    let ffprobe =
        find_tool("ffprobe.exe").context("FFprobe is required to verify the downloaded media.")?;
    let runtime = find_tool("deno.exe")
        .context("The YouTube JavaScript runtime is missing. Install Current's media runtime.")?;
    let directory = store.parts(&job.id).join("media");
    fs::create_dir_all(&directory).await?;
    let output = directory.join(format!("payload.{}", options.extension()));
    let template = format!(
        "{}{}payload.%(ext)s",
        directory.to_string_lossy().replace('%', "%%"),
        std::path::MAIN_SEPARATOR
    );
    let mut command = process(&downloader);
    command.args(["--ignore-config","--no-plugin-dirs","--no-exec","--no-playlist","--no-overwrites","--continue","--no-cache-dir","--no-allow-unplayable-formats","--abort-on-unavailable-fragments","--newline","--progress","--progress-delta","0.5","--socket-timeout","20","--retries","2","--fragment-retries","2","--extractor-retries","1","--concurrent-fragments","2","--match-filter","!is_live"])
        .arg("--ffmpeg-location").arg(ffmpeg.parent().context("Missing FFmpeg directory")?)
        .arg("--js-runtimes").arg(format!("deno:{}",runtime.display()))
        .arg("--progress-template").arg("download:CURRENT_PROGRESS:{\"downloaded\":%(progress.downloaded_bytes)j,\"total\":%(progress.total_bytes,progress.total_bytes_estimate)j,\"file\":%(progress.filename)j}")
        .arg("--progress-template").arg("postprocess:CURRENT_POST:%(progress.status)j")
        .arg("--print").arg("after_move:CURRENT_RESULT:%(filepath)j").arg("--no-simulate")
        .arg("-f").arg(format_selector(options)).arg("-o").arg(template);
    if options.mode != MediaMode::Video {
        command.args([
            "--extract-audio",
            "--audio-format",
            options.extension(),
            "--audio-quality",
            "0",
        ]);
    } else {
        command.args(["--merge-output-format", "mp4", "--remux-video", "mp4"]);
    }
    let limit = match (job.speed_limit, store.settings()?.speed_limit) {
        (0, b) => b,
        (a, 0) => a,
        (a, b) => a.min(b),
    };
    if limit > 0 {
        command.arg("--limit-rate").arg(limit.to_string());
    }
    command.arg("--").arg(&job.url);
    let mut child = command
        .spawn()
        .context("Could not launch Current's YouTube downloader")?;
    let mut tree = match ProcessTree::attach(&child) {
        Ok(tree) => Some(tree),
        Err(error) => {
            let _ = child.kill().await;
            return Err(error.context("Could not contain media subprocesses"));
        }
    };
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut out_open = true;
    let mut err_open = true;
    let mut progress = Progress::default();
    let mut errors = VecDeque::new();
    while out_open || err_open {
        tokio::select! {
            _=cancel.cancelled()=>{drop(tree.take());let _=child.kill().await;return Ok(None);},
            line=stdout.next_line(),if out_open=>match line? {
                None=>out_open=false,
                Some(line)=>{
                    if let Some(raw)=line.strip_prefix("CURRENT_PROGRESS:") {
                        if let Ok(value)=serde_json::from_str::<Value>(raw){let(done,total,delta)=progress.update(&value);bytes.fetch_add(delta,Ordering::Relaxed);store.update(&job.id,|j|{if matches!(j.status,Status::Probing|Status::Downloading){j.status=Status::Downloading;j.downloaded=done;j.total=total;j.resumable=true;}})?;}
                    }else if line.starts_with("CURRENT_POST:"){store.update(&job.id,|j|{if matches!(j.status,Status::Probing|Status::Downloading){j.status=Status::Assembling;}})?;}
                },
            },
            line=stderr.next_line(),if err_open=>match line? {None=>err_open=false,Some(line)=>{if errors.len()>=12{errors.pop_front();}errors.push_back(line.chars().take(600).collect::<String>());}},
        }
    }
    let status = tokio::select! {_=cancel.cancelled()=>{drop(tree.take());let _=child.kill().await;return Ok(None);},status=child.wait()=>status?};
    drop(tree);
    if !status.success() {
        let detail = errors.into_iter().collect::<Vec<_>>().join("\n");
        bail!("YouTube download failed. {detail}");
    }
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&output)
        .await
        .context("The media tool did not create the expected MP4/M4A file")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        bail!("The media output is not a valid nonempty regular file.");
    }
    store.update(&job.id, |j| {
        if matches!(
            j.status,
            Status::Probing | Status::Downloading | Status::Assembling
        ) {
            j.status = Status::Verifying;
        }
    })?;
    let mut probe = process(&ffprobe);
    probe
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name",
            "-of",
            "json",
        ])
        .arg(&output);
    let probe_child = probe.spawn()?;
    let mut probe_tree = Some(ProcessTree::attach(&probe_child)?);
    let result = tokio::select! {_=cancel.cancelled()=>{drop(probe_tree.take());return Ok(None);},result=tokio::time::timeout(Duration::from_secs(30),probe_child.wait_with_output())=>result.context("Media verification timed out")??};
    drop(probe_tree);
    if !result.status.success() {
        bail!("FFprobe could not verify the downloaded media.");
    }
    validate_streams(&serde_json::from_slice(&result.stdout)?, &options.mode)?;
    Ok(Some(output))
}
fn validate_streams(value: &Value, mode: &MediaMode) -> Result<()> {
    let streams = value["streams"]
        .as_array()
        .context("Media verification returned no streams")?;
    let required = if *mode != MediaMode::Video {
        "audio"
    } else {
        "video"
    };
    if !streams.iter().any(|s| s["codec_type"] == required) {
        bail!("The output does not contain the requested {required} stream.");
    }
    if *mode == MediaMode::Mp3 && !streams.iter().any(|s| s["codec_name"] == "mp3") {
        bail!("MP3 verification failed: the output audio is not encoded as MP3.");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn video_urls_are_strict_and_single_item() {
        for s in [
            "https://www.youtube.com/watch?v=BaW_jenozKc&list=abc",
            "https://youtu.be/BaW_jenozKc",
            "https://www.youtube.com/shorts/BaW_jenozKc",
        ] {
            assert_eq!(
                youtube_id(&Url::parse(s).unwrap()).as_deref(),
                Some("BaW_jenozKc")
            );
        }
        for s in [
            "https://youtube.com.evil.test/watch?v=BaW_jenozKc",
            "https://youtube.com/playlist?list=x",
            "https://youtube.com/watch?v=--exec",
            "https://user:pass@youtube.com/watch?v=BaW_jenozKc",
        ] {
            assert!(youtube_id(&Url::parse(s).unwrap()).is_none());
        }
    }
    #[test]
    fn progress_accounts_for_separate_video_and_audio() {
        let mut progress = Progress::default();
        assert_eq!(
            progress.update(&serde_json::json!({"file":"video","downloaded":100,"total":200})),
            (100, Some(200), 100)
        );
        assert_eq!(
            progress.update(&serde_json::json!({"file":"audio","downloaded":40,"total":80})),
            (140, Some(280), 40)
        );
    }
    #[test]
    fn output_must_contain_the_requested_media_stream() {
        assert!(validate_streams(
            &serde_json::json!({"streams":[{"codec_type":"audio"}]}),
            &MediaMode::Video
        )
        .is_err());
        assert!(validate_streams(
            &serde_json::json!({"streams":[{"codec_type":"audio"}]}),
            &MediaMode::Audio
        )
        .is_ok());
    }

    #[test]
    fn format_menu_lists_only_available_unprotected_resolutions() {
        let value = serde_json::json!({"title":"Fixture","formats":[
            {"height":360,"vcodec":"avc1","acodec":"aac","url":"https://secret.example/token"},
            {"height":720,"vcodec":"vp9","acodec":"none"},
            {"height":720,"vcodec":"avc1","acodec":"none"},
            {"height":1080,"vcodec":"avc1","has_drm":true},
            {"height":608,"vcodec":"avc1","acodec":"none"},
            {"height":8641,"vcodec":"avc1"},
            {"height":144,"vcodec":"none","acodec":"none"}]});
        let menu = summarize_formats(&value).unwrap();
        assert_eq!(menu["heights"], serde_json::json!([720, 608, 360]));
        assert_eq!(menu["audio_available"], true);
        assert!(!menu.to_string().contains("secret"));
    }

    #[test]
    fn mp3_requires_real_mp3_audio() {
        let options = MediaOptions {
            mode: MediaMode::Mp3,
            max_height: 720,
        };
        assert_eq!(options.extension(), "mp3");
        assert_eq!(format_selector(&options), "bestaudio/best");
        assert!(validate_streams(
            &serde_json::json!({"streams":[{"codec_type":"audio","codec_name":"aac"}]}),
            &MediaMode::Mp3
        )
        .is_err());
        assert!(validate_streams(
            &serde_json::json!({"streams":[{"codec_type":"audio","codec_name":"mp3"}]}),
            &MediaMode::Mp3
        )
        .is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires the installed yt-dlp, Deno and FFmpeg runtime"]
    async fn real_dash_video_audio_merge_and_audio_only_publish() {
        use crate::{AddRequest, Engine, Settings};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let temp = tempfile::tempdir().unwrap();
        let fixtures = temp.path().join("fixtures");
        fs::create_dir_all(&fixtures).await.unwrap();
        let mut generate = process(&find_tool("ffmpeg.exe").expect("FFmpeg required"));
        generate
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x90:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "2",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-seg_duration",
                "1",
                "-adaptation_sets",
                "id=0,streams=v id=1,streams=a",
                "-f",
                "dash",
            ])
            .current_dir(&fixtures)
            .arg("manifest.mpd");
        let generated = generate.output().await.unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let root = fixtures.clone();
                tokio::spawn(async move {
                    let mut request = vec![0; 8192];
                    let n = socket.read(&mut request).await.unwrap_or(0);
                    let text = String::from_utf8_lossy(&request[..n]);
                    let name = text
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .trim_start_matches('/')
                        .split('?')
                        .next()
                        .unwrap();
                    if name.contains("..") || name.contains('/') {
                        return;
                    }
                    let data = match fs::read(root.join(name)).await {
                        Ok(data) => data,
                        Err(error) => {
                            eprintln!("Fixture resource missing: {name}: {error}");
                            return;
                        }
                    };
                    let mime = if name.ends_with(".mpd") {
                        "application/dash+xml"
                    } else {
                        "application/octet-stream"
                    };
                    let headers=format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nConnection: close\r\n\r\n",data.len());
                    let _ = socket.write_all(headers.as_bytes()).await;
                    let _ = socket.write_all(&data).await;
                });
            }
        });
        for mode in [MediaMode::Video, MediaMode::Audio, MediaMode::Mp3] {
            let engine = Engine::new(
                Store::open(&temp.path().join(format!(
                    "data-{}",
                    match mode {
                        MediaMode::Video => "video",
                        MediaMode::Audio => "audio",
                        MediaMode::Mp3 => "mp3",
                    }
                )))
                .unwrap(),
            )
            .unwrap();
            // Seed an internal fixture job; production admission only accepts YouTube video URLs.
            let mut job = Job::new(
                AddRequest {
                    url: "https://www.youtube.com/watch?v=BaW_jenozKc".into(),
                    media: Some(MediaOptions {
                        mode: mode.clone(),
                        max_height: 1080,
                    }),
                    filename: None,
                    folder: Some(temp.path().join("output").to_string_lossy().into()),
                    later: None,
                    queue: None,
                    description: None,
                    referer: None,
                    expected_sha256: None,
                    start_at: None,
                },
                &Settings::default(),
            )
            .unwrap();
            job.url = format!("http://{address}/manifest.mpd");
            engine.store.save(&job).unwrap();
            let scheduler = tokio::spawn(engine.clone().scheduler());
            let done = tokio::time::timeout(Duration::from_secs(60), async {
                loop {
                    let j = engine.store.get(&job.id).unwrap();
                    if matches!(j.status, Status::Completed | Status::Failed) {
                        break j;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(done.status, Status::Completed, "{:?}", done.error);
            assert!(done.output().is_file());
            assert!(done.downloaded > 0);
            assert_eq!(done.sha256.as_ref().unwrap().len(), 64);
            let probe = process(&find_tool("ffprobe.exe").unwrap())
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_type,codec_name",
                    "-of",
                    "json",
                ])
                .arg(done.output())
                .output()
                .await
                .unwrap();
            let info: Value = serde_json::from_slice(&probe.stdout).unwrap();
            validate_streams(&info, &mode).unwrap();
            assert!(info["streams"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["codec_type"] == "audio"));
            scheduler.abort();
        }
        server.abort();
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "starts a contained Windows parent and child to verify cancellation"]
    async fn dropping_process_tree_terminates_descendants() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, WaitForSingleObject},
        };
        let mut command = process(Path::new(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        ));
        command.args(["-NoProfile","-NonInteractive","-Command",r"$p=Start-Process -FilePath 'C:\Windows\System32\ping.exe' -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output $p.Id; Start-Sleep -Seconds 30"]);
        let mut child = command.spawn().unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), reader.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let pid: u32 = line.trim().parse().unwrap();
        let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
        assert!(!handle.is_null());
        drop(tree);
        let _status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unsafe { WaitForSingleObject(handle, 3000) }, 0);
        unsafe {
            CloseHandle(handle);
        }
    }
}
