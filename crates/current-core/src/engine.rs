use crate::{model::*, Store};
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::{header, Client, Response, StatusCode};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

struct Running {
    cancel: CancellationToken,
    bytes: Arc<AtomicU64>,
    started: Instant,
}
#[derive(Debug)]
struct RangeIgnored;
impl std::fmt::Display for RangeIgnored {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "The server ignored its requested byte range. Existing bytes were not appended."
        )
    }
}
impl std::error::Error for RangeIgnored {}
pub struct Engine {
    pub store: Arc<Store>,
    client: Client,
    active: Mutex<HashMap<String, Running>>,
    origins: Mutex<HashMap<String, Arc<Semaphore>>>,
    workers: Arc<Semaphore>,
    admission: Mutex<()>,
    stopping: AtomicBool,
    pub plan: Plan,
}

impl Engine {
    pub fn new(store: Store) -> Result<Arc<Self>> {
        let plan = Plan::default();
        let client = Client::builder()
            .user_agent(concat!("Current/", env!("CARGO_PKG_VERSION")))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .referer(false)
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("Too many redirects")
                } else if !matches!(attempt.url().scheme(), "http" | "https") {
                    attempt.error("Unsafe redirect scheme")
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        Ok(Arc::new(Self {
            store: Arc::new(store),
            client,
            active: Mutex::new(HashMap::new()),
            origins: Mutex::new(HashMap::new()),
            workers: Arc::new(Semaphore::new(if plan.paid_features { 64 } else { 4 })),
            admission: Mutex::new(()),
            stopping: AtomicBool::new(false),
            plan,
        }))
    }

    pub fn add(&self, request: AddRequest) -> Result<Job> {
        let _guard = self.admission.lock().unwrap();
        if self.stopping.load(Ordering::SeqCst) {
            bail!("The background engine is shutting down.");
        }
        if request.start_at.is_some() && !self.plan.paid_features {
            bail!("Scheduled downloads require Pro. Billing is not enabled in this build.");
        }
        if request.queue.as_deref().is_some_and(|s| s != "Main queue") && !self.plan.paid_features {
            bail!("Multiple queues require Pro.");
        }
        let settings = self.store.settings()?;
        let mut job = Job::new(request, &settings)?;
        if job.media.is_some() && !self.plan.paid_features {
            bail!("YouTube video/audio downloads require Pro. Development Pro includes this feature for testing.");
        }
        job.connections = job.connections.clamp(1, self.plan.max_connections);
        let existing = self.store.list()?;
        let base = job.filename.clone();
        let mut suffix = 1;
        while job.output().exists()
            || existing.iter().any(|j| {
                j.output()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&job.output().to_string_lossy())
            })
        {
            let p = Path::new(&base);
            let stem = p.file_stem().unwrap_or_default().to_string_lossy();
            job.filename = match p.extension() {
                Some(ext) => format!("{stem} ({suffix}).{}", ext.to_string_lossy()),
                None => format!("{stem} ({suffix})"),
            };
            suffix += 1;
        }
        self.store.save(&job)?;
        Ok(job)
    }

    pub fn snapshot(&self) -> Result<serde_json::Value> {
        let mut jobs = self.store.list()?;
        let active = self.active.lock().unwrap();
        for job in &mut jobs {
            job.speed = active
                .get(&job.id)
                .map(|r| {
                    (r.bytes.load(Ordering::Relaxed) as f64
                        / r.started.elapsed().as_secs_f64().max(0.1)) as u64
                })
                .unwrap_or(0);
        }
        Ok(
            serde_json::json!({"jobs":jobs,"settings":self.store.settings()?,"plan":self.plan,"version":VERSION,"engine":"online","media":crate::media::capabilities()}),
        )
    }

    pub fn action(&self, id: &str, action: &str) -> Result<()> {
        let active = self.active.lock().unwrap();
        match action {
            "pause" | "cancel" => {
                let status = if action == "cancel" {
                    Status::Cancelled
                } else if active.contains_key(id) {
                    Status::Pausing
                } else {
                    Status::Paused
                };
                let job = self.store.get(id)?;
                if job.status == Status::Completed {
                    bail!("This download has already completed.");
                }
                self.store.update(id, |j| {
                    j.status = status;
                    j.speed = 0;
                })?;
                if let Some(r) = active.get(id) {
                    r.cancel.cancel();
                }
            }
            "resume" => {
                if active.contains_key(id) {
                    bail!("Wait until the current operation has stopped.");
                }
                let job = self.store.get(id)?;
                if job.status == Status::Completed {
                    bail!("This file is complete. Add the URL again to make another copy.");
                }
                self.store.update(id, |j| {
                    j.status = Status::Queued;
                    j.error = None;
                    j.start_at = None;
                })?;
            }
            "restart" => {
                if active.contains_key(id) {
                    bail!("Pause the transfer before restarting.");
                }
                let job = self.store.get(id)?;
                if job.status == Status::Completed {
                    bail!("Add this URL again to redownload it.");
                }
                cleanup_staging(&job)?;
                let parts = self.store.parts(id);
                if parts.exists() {
                    std::fs::remove_dir_all(parts)?;
                }
                self.store.update(id, |j| {
                    j.status = Status::Queued;
                    j.error = None;
                    j.segments.clear();
                    j.total = None;
                    j.downloaded = 0;
                    j.validator = None;
                    j.sha256 = None;
                    j.completed_at = None;
                    j.start_at = None;
                })?;
            }
            "remove" => {
                if active.contains_key(id) {
                    bail!("Pause and wait before removing this item.");
                }
                let job = self.store.get(id)?;
                cleanup_staging(&job)?;
                self.store.remove(id)?;
                let parts = self.store.parts(id);
                if parts.exists() {
                    std::fs::remove_dir_all(parts)?;
                }
            }
            _ => bail!("Unknown download action."),
        }
        Ok(())
    }

    pub fn save_settings(&self, mut settings: Settings) -> Result<Settings> {
        if !Path::new(&settings.download_folder).is_absolute() {
            bail!("Choose an absolute download folder.");
        }
        settings.connections = settings.connections.clamp(1, self.plan.max_connections);
        settings.max_active = settings.max_active.clamp(1, self.plan.max_active);
        if !matches!(settings.language.as_str(), "en" | "ar") {
            bail!("Unsupported language.");
        }
        self.store.save_settings(&settings)?;
        Ok(settings)
    }

    pub async fn scheduler(self: Arc<Self>) {
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            if let (Ok(settings), Ok(jobs)) = (self.store.settings(), self.store.list()) {
                for job in jobs.into_iter().rev() {
                    if job.status != Status::Queued {
                        continue;
                    }
                    if job.start_at.as_ref().is_some_and(|s| {
                        chrono::DateTime::parse_from_rfc3339(s).is_ok_and(|d| d > Utc::now())
                    }) {
                        continue;
                    }
                    let cancel = CancellationToken::new();
                    let bytes = Arc::new(AtomicU64::new(0));
                    {
                        let mut active = self.active.lock().unwrap();
                        if self.stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        if active.len() >= settings.max_active.min(self.plan.max_active) {
                            break;
                        }
                        if active.contains_key(&job.id) {
                            continue;
                        }
                        active.insert(
                            job.id.clone(),
                            Running {
                                cancel: cancel.clone(),
                                bytes: bytes.clone(),
                                started: Instant::now(),
                            },
                        );
                    }
                    let engine = self.clone();
                    tokio::spawn(async move {
                        let result = engine
                            .clone()
                            .run(job.id.clone(), cancel.clone(), bytes)
                            .await;
                        let _ = engine.store.update(&job.id, |j| {
                            if j.status == Status::Cancelled {
                                return;
                            }
                            if j.status == Status::Pausing
                                || cancel.is_cancelled() && result.is_ok()
                            {
                                j.status = Status::Paused;
                                j.speed = 0;
                            } else if let Err(ref e) = result {
                                j.status = Status::Failed;
                                j.error = Some(format!("{e:#}"));
                                j.speed = 0;
                            }
                        });
                        engine.active.lock().unwrap().remove(&job.id);
                    });
                }
            }
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
    }

    pub fn request_shutdown(&self) -> Result<()> {
        self.stopping.store(true, Ordering::SeqCst);
        for j in self.store.list()? {
            if j.status.active() || j.status == Status::Queued {
                self.action(&j.id, "pause")?;
            }
        }
        Ok(())
    }

    pub async fn wait_stopped(&self) {
        loop {
            if self.active.lock().unwrap().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn request(&self, job: &Job) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .get(&job.url)
            .header(header::ACCEPT_ENCODING, "identity");
        if let Some(ref r) = job.referer {
            if let (Ok(source), Ok(target)) = (validate_url(r), validate_url(&job.url)) {
                if !(source.scheme() == "https" && target.scheme() == "http") {
                    request = request.header(
                        header::REFERER,
                        format!("{}/", source.origin().ascii_serialization()),
                    );
                }
            }
        }
        request
    }

    async fn probe(
        &self,
        job: &Job,
        cancel: &CancellationToken,
    ) -> Result<(Option<u64>, bool, Option<String>)> {
        let response = tokio::select! { _=cancel.cancelled()=>bail!("Paused"), result=self.request(job).header(header::RANGE,"bytes=0-0").send()=>result? };
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE
            && response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                == Some("bytes */0")
        {
            return Ok((Some(0), false, None));
        }
        if !response.status().is_success() {
            bail!("Server returned HTTP {}.", response.status());
        }
        check_encoding(&response)?;
        let validator = response
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.starts_with("W/"))
            .map(str::to_string);
        if response.status() == StatusCode::PARTIAL_CONTENT {
            let (start, end, total) = parse_content_range(
                response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            )?;
            if start != 0 || end != 0 {
                bail!("Server returned an unexpected probe range.");
            }
            Ok((Some(total), true, validator))
        } else {
            Ok((response.content_length(), false, validator))
        }
    }

    async fn run(
        self: Arc<Self>,
        id: String,
        cancel: CancellationToken,
        bytes: Arc<AtomicU64>,
    ) -> Result<()> {
        let initial = self.store.update(&id, |j| {
            if j.status == Status::Queued {
                j.status = Status::Probing;
                j.error = None;
            }
        })?;
        if initial.status != Status::Probing || cancel.is_cancelled() {
            return Ok(());
        }
        // Recover the rename/database crash window using the digest persisted before publishing.
        if let Some(ref expected) = initial.sha256 {
            if initial.output().is_file() {
                let actual = hash_file(&initial.output(), &cancel).await?;
                if &actual != expected {
                    bail!("An output file exists but differs from the saved verification record. It was not overwritten.");
                }
                self.store.update(&id, |j| {
                    j.status = Status::Completed;
                    j.completed_at = Some(Utc::now().to_rfc3339());
                    j.error = None;
                })?;
                let _ = fs::remove_dir_all(self.store.parts(&id)).await;
                return Ok(());
            }
        }
        if initial.media.is_some() {
            if initial.total.is_some_and(|n| n == initial.downloaded)
                && !initial.segments.is_empty()
                && initial
                    .segments
                    .iter()
                    .all(|s| s.end != u64::MAX && s.committed == s.end - s.start)
            {
                self.store.update(&id, |j| {
                    if j.status == Status::Probing {
                        j.status = Status::Downloading;
                    }
                })?;
                return self.finalize(&id, &cancel).await;
            }
            if let Some(output) =
                crate::media::download(&initial, self.store.clone(), &cancel, bytes).await?
            {
                if cancel.is_cancelled() {
                    return Ok(());
                }
                let length = fs::metadata(&output).await?.len();
                let part = self.store.parts(&id).join("0.part");
                // A prior finalized part may remain after a cancelled assembly.
                // Both paths belong to this UUID, never the user's completed file.
                if part.is_file() {
                    fs::remove_file(&part).await?;
                }
                fs::rename(output, &part).await?;
                let ready = self.store.update(&id, |j| {
                    if matches!(
                        j.status,
                        Status::Probing
                            | Status::Downloading
                            | Status::Assembling
                            | Status::Verifying
                    ) {
                        j.status = Status::Downloading;
                        j.total = Some(length);
                        j.downloaded = length;
                        j.segments = split_ranges(length, 1);
                        j.segments[0].committed = length;
                    }
                })?;
                if ready.status != Status::Downloading {
                    return Ok(());
                }
                return self.finalize(&id, &cancel).await;
            }
            return Ok(());
        }
        if initial.total.is_some_and(|n| n == initial.downloaded)
            && initial
                .segments
                .iter()
                .all(|s| s.end != u64::MAX && s.committed == s.end - s.start)
        {
            self.store.update(&id, |j| {
                if j.status == Status::Probing {
                    j.status = Status::Downloading;
                }
            })?;
            return self.finalize(&id, &cancel).await;
        }
        let (total, ranges, validator) = match self.probe(&initial, &cancel).await {
            Err(_) if cancel.is_cancelled() => return Ok(()),
            other => other?,
        };
        if cancel.is_cancelled() {
            return Ok(());
        }
        if initial.downloaded > 0 {
            if !ranges
                || validator.is_none()
                || initial.validator != validator
                || initial.total != total
            {
                bail!("Source cannot be safely resumed or has changed. Use Restart to begin a new copy; existing parts are preserved.");
            }
        }
        let dir = self.store.parts(&id);
        fs::create_dir_all(&dir).await?;
        let job = self.store.update(&id, |j| {
            if j.status != Status::Probing {
                return;
            }
            if j.downloaded == 0 && (j.total != total || j.validator != validator) {
                j.segments.clear();
            }
            j.total = total;
            j.validator = validator;
            j.resumable = ranges && j.validator.is_some();
            if j.segments.is_empty() {
                j.segments = match total {
                    Some(n) if n > 0 => split_ranges(
                        n,
                        if ranges && j.validator.is_some() && n >= 2 * 1024 * 1024 {
                            j.connections.min(self.plan.max_connections)
                        } else {
                            1
                        },
                    ),
                    Some(_) => vec![],
                    None => vec![Segment {
                        index: 0,
                        start: 0,
                        end: u64::MAX,
                        committed: 0,
                    }],
                };
            }
            j.status = Status::Downloading;
        })?;
        if job.status != Status::Downloading || cancel.is_cancelled() {
            return Ok(());
        }
        let host = validate_url(&job.url)?.origin().ascii_serialization();
        let origin = self
            .origins
            .lock()
            .unwrap()
            .entry(host)
            .or_insert_with(|| {
                Arc::new(Semaphore::new(if self.plan.paid_features { 8 } else { 2 }))
            })
            .clone();
        let mut tasks = JoinSet::new();
        let transfer_cancel = cancel.child_token();
        let segment_count = job.segments.len();
        for segment in job.segments.clone() {
            if segment.end != u64::MAX && segment.committed == segment.end - segment.start {
                continue;
            }
            let engine = self.clone();
            let job = job.clone();
            let cancel = transfer_cancel.clone();
            let bytes = bytes.clone();
            let origin = origin.clone();
            tasks.spawn(async move {
                engine
                    .transfer_segment(job, segment, segment_count, cancel, bytes, origin)
                    .await
            });
        }
        let mut failure = None;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if failure.is_none() {
                        failure = Some(e);
                    }
                    transfer_cancel.cancel();
                }
                Err(e) => {
                    if failure.is_none() {
                        failure = Some(e.into());
                    }
                    transfer_cancel.cancel();
                }
            }
        }
        if self.store.get(&id)?.status == Status::Pausing
            || self.store.get(&id)?.status == Status::Cancelled
        {
            return Ok(());
        }
        if let Some(e) = failure {
            if e.downcast_ref::<RangeIgnored>().is_some()
                && initial.downloaded == 0
                && self.store.get(&id)?.downloaded == 0
                && !cancel.is_cancelled()
            {
                let single = self.store.update(&id, |j| {
                    j.connections = 1;
                    j.resumable = false;
                    j.segments = split_ranges(j.total.unwrap_or(0), 1);
                })?;
                if let Some(segment) = single.segments.first().cloned() {
                    self.clone()
                        .transfer_segment(single, segment, 1, cancel.child_token(), bytes, origin)
                        .await?;
                }
            } else {
                return Err(e);
            }
        }
        if cancel.is_cancelled() {
            return Ok(());
        }
        self.finalize(&id, &cancel).await
    }

    async fn transfer_segment(
        self: Arc<Self>,
        job: Job,
        mut segment: Segment,
        segment_count: usize,
        cancel: CancellationToken,
        bytes: Arc<AtomicU64>,
        origin: Arc<Semaphore>,
    ) -> Result<()> {
        let _global = tokio::select! {_=cancel.cancelled()=>return Ok(()),p=self.workers.clone().acquire_owned()=>p?};
        let _origin =
            tokio::select! {_=cancel.cancelled()=>return Ok(()),p=origin.acquire_owned()=>p?};
        let part = self
            .store
            .parts(&job.id)
            .join(format!("{}.part", segment.index));
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .read(true)
            .truncate(false)
            .open(&part)
            .await?;
        if file.metadata().await?.len() < segment.committed {
            bail!("A saved part is missing or shorter than its checkpoint. Restart this download.");
        }
        file.set_len(segment.committed).await?;
        tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(segment.committed))
            .await?;
        let offset = segment
            .start
            .checked_add(segment.committed)
            .context("Range overflow")?;
        let use_range = job.resumable && (segment_count > 1 || segment.committed > 0);
        let mut request = self.request(&job);
        if use_range {
            request = request.header(
                header::RANGE,
                format!("bytes={}-{}", offset, segment.end - 1),
            );
            if let Some(ref v) = job.validator {
                request = request.header(header::IF_RANGE, v);
            }
        }
        let response = tokio::select! {_=cancel.cancelled()=>return Ok(()),r=request.send()=>r?};
        check_encoding(&response)?;
        if use_range {
            if response.status() == StatusCode::OK {
                return Err(RangeIgnored.into());
            }
            if response.status() != StatusCode::PARTIAL_CONTENT {
                bail!(
                    "Server refused the requested range (HTTP {}). Existing parts are preserved.",
                    response.status()
                );
            }
            let (a, b, total) = parse_content_range(
                response
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            )?;
            if a != offset || b.checked_add(1) != Some(segment.end) || Some(total) != job.total {
                bail!("Server returned a mismatched byte range.");
            }
        } else if response.status() != StatusCode::OK {
            bail!("Server returned HTTP {}.", response.status());
        }
        if let Some(ref expected) = job.validator {
            if response
                .headers()
                .get(header::ETAG)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v != expected)
            {
                bail!("The source changed during transfer. Existing parts are preserved.");
            }
        }
        let initial = segment.committed;
        let started = Instant::now();
        let mut checkpoint = Instant::now();
        let mut pending = 0_u64;
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::select! {_=cancel.cancelled()=>None,next=stream.next()=>next};
            let Some(chunk) = next else {
                break;
            };
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    self.checkpoint(&job.id, &mut file, &mut segment, pending)
                        .await?;
                    return Err(e.into());
                }
            };
            if segment.end != u64::MAX
                && segment.committed + pending + chunk.len() as u64 > segment.end - segment.start
            {
                bail!("Server sent more bytes than requested.");
            }
            file.write_all(&chunk).await?;
            pending += chunk.len() as u64;
            bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            if checkpoint.elapsed() >= Duration::from_millis(700) {
                self.checkpoint(&job.id, &mut file, &mut segment, pending)
                    .await?;
                pending = 0;
                checkpoint = Instant::now();
            }
            let global = self.store.settings()?.speed_limit;
            let limit = match (job.speed_limit, global) {
                (0, b) => b,
                (a, 0) => a,
                (a, b) => a.min(b),
            };
            if limit > 0 {
                let per_worker = (limit / (segment_count.max(1) as u64)).max(1);
                let desired = Duration::from_secs_f64(
                    (segment.committed + pending - initial) as f64 / per_worker as f64,
                );
                if desired > started.elapsed() {
                    tokio::select! {_=cancel.cancelled()=>{},_=tokio::time::sleep(desired-started.elapsed())=>{}}
                }
            }
        }
        self.checkpoint(&job.id, &mut file, &mut segment, pending)
            .await?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        if segment.end != u64::MAX && segment.committed != segment.end - segment.start {
            bail!("Connection ended before the expected file length. Resume to retry.");
        }
        if segment.end == u64::MAX {
            self.store.update(&job.id, |j| {
                j.total = Some(segment.committed);
                j.segments[segment.index].end = segment.committed;
            })?;
        }
        Ok(())
    }

    async fn checkpoint(
        &self,
        id: &str,
        file: &mut File,
        segment: &mut Segment,
        pending: u64,
    ) -> Result<()> {
        file.sync_data().await?;
        segment.committed = segment
            .committed
            .checked_add(pending)
            .context("Progress overflow")?;
        self.store.update(id, |j| {
            j.segments[segment.index].committed = segment.committed;
            j.downloaded = j.segments.iter().map(|s| s.committed).sum();
        })?;
        Ok(())
    }

    async fn finalize(&self, id: &str, cancel: &CancellationToken) -> Result<()> {
        let job = self.store.update(id, |j| {
            if j.status == Status::Downloading {
                j.status = Status::Assembling;
            }
        })?;
        if job.status != Status::Assembling || cancel.is_cancelled() {
            return Ok(());
        }
        fs::create_dir_all(&job.folder).await?;
        if job.output().exists() {
            bail!("The destination file already exists. It was not overwritten.");
        }
        let staging = Path::new(&job.folder).join(format!(".current-{}.assembling", job.id));
        if let Ok(metadata) = fs::symlink_metadata(&staging).await {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("The staging path is not a regular file.");
            }
            fs::remove_file(&staging).await?;
        }
        let mut out = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .await?;
        let mut hash = Sha256::new();
        let mut count = 0_u64;
        let mut buffer = vec![0u8; 256 * 1024];
        for s in &job.segments {
            let mut input =
                File::open(self.store.parts(id).join(format!("{}.part", s.index))).await?;
            loop {
                if cancel.is_cancelled() {
                    drop(out);
                    let _ = fs::remove_file(&staging).await;
                    return Ok(());
                }
                let read = input.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                out.write_all(&buffer[..read]).await?;
                hash.update(&buffer[..read]);
                count += read as u64;
            }
        }
        out.sync_all().await?;
        drop(out);
        self.store.update(id, |j| {
            if j.status == Status::Assembling {
                j.status = Status::Verifying;
            }
        })?;
        if job.total.is_some_and(|n| n != count) {
            bail!("Assembled length does not match the expected file length.");
        }
        let sha = hex::encode(hash.finalize());
        if job.expected_sha256.as_ref().is_some_and(|s| s != &sha) {
            bail!(
                "SHA-256 verification failed. The output was not published; parts are preserved."
            );
        }
        self.store.update(id, |j| j.sha256 = Some(sha.clone()))?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        // Staging is on the output volume. Windows MoveFileEx without REPLACE_EXISTING
        // prevents overwriting a destination created after admission and also supports exFAT.
        publish_output(staging.clone(), job.output()).await?;
        self.store.update(id, |j| {
            j.status = Status::Completed;
            j.sha256 = Some(sha);
            j.total = Some(count);
            j.downloaded = count;
            j.completed_at = Some(Utc::now().to_rfc3339());
            j.error = None;
            j.speed = 0;
        })?;
        let _ = fs::remove_file(staging).await;
        let _ = fs::remove_dir_all(self.store.parts(id)).await;
        Ok(())
    }
}

fn check_encoding(response: &Response) -> Result<()> {
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| !s.eq_ignore_ascii_case("identity"))
    {
        bail!("Server ignored byte-preserving encoding. This response cannot be safely segmented.");
    }
    Ok(())
}

fn cleanup_staging(job: &Job) -> Result<()> {
    let path = Path::new(&job.folder).join(format!(".current-{}.assembling", job.id));
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            std::fs::remove_file(path)?
        }
        Ok(_) => bail!("A non-file occupies the staging path; it was not removed."),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

async fn hash_file(path: &Path, cancel: &CancellationToken) -> Result<String> {
    let mut file = File::open(path).await?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        if cancel.is_cancelled() {
            bail!("Verification paused");
        }
        let n = file.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}

async fn publish_output(staging: PathBuf, destination: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let from: Vec<u16> = staging.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = destination
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            if unsafe {
                windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    0x8,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error()).context(
                    "Could not publish the output; an existing destination was not overwritten",
                );
            }
        }
        #[cfg(not(windows))]
        {
            std::fs::hard_link(&staging, &destination)?;
            std::fs::remove_file(staging)?;
        }
        Ok(())
    })
    .await??;
    Ok(())
}

pub fn parse_content_range(s: &str) -> Result<(u64, u64, u64)> {
    let value = s
        .strip_prefix("bytes ")
        .ok_or_else(|| anyhow!("Missing or invalid Content-Range"))?;
    let (range, total) = value.split_once('/').context("Invalid Content-Range")?;
    let (a, b) = range.split_once('-').context("Invalid Content-Range")?;
    let (a, b, total) = (a.parse::<u64>()?, b.parse::<u64>()?, total.parse::<u64>()?);
    if a > b || b >= total {
        bail!("Invalid Content-Range bounds");
    }
    Ok((a, b, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_range_headers() {
        assert_eq!(parse_content_range("bytes 0-0/100").unwrap(), (0, 0, 100));
        for bad in [
            "",
            "bytes */10",
            "bytes 5-3/10",
            "bytes 0-10/10",
            "bytes 0-0/*",
        ] {
            assert!(parse_content_range(bad).is_err());
        }
    }
    #[test]
    fn durable_restart_recovers_state() {
        let t = tempfile::tempdir().unwrap();
        let s = Store::open(t.path()).unwrap();
        let mut j = Job::new(
            AddRequest {
                media: None,
                url: "https://example.org/a.zip".into(),
                filename: None,
                folder: Some(t.path().to_string_lossy().into()),
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
        j.status = Status::Downloading;
        s.save(&j).unwrap();
        drop(s);
        let s = Store::open(t.path()).unwrap();
        assert_eq!(s.get(&j.id).unwrap().status, Status::Paused);
    }
}
