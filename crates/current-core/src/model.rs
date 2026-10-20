use anyhow::{bail, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use url::Url;
use uuid::Uuid;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Probing,
    Downloading,
    Pausing,
    Paused,
    Assembling,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    pub fn active(&self) -> bool {
        matches!(
            self,
            Self::Probing | Self::Downloading | Self::Pausing | Self::Assembling | Self::Verifying
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub committed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    #[serde(default)]
    pub media: Option<crate::media::MediaOptions>,
    pub id: String,
    pub url: String,
    pub filename: String,
    pub folder: String,
    pub category: String,
    pub queue: String,
    pub status: Status,
    pub total: Option<u64>,
    pub downloaded: u64,
    pub speed: u64,
    pub connections: usize,
    pub resumable: bool,
    pub validator: Option<String>,
    pub segments: Vec<Segment>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub sha256: Option<String>,
    pub expected_sha256: Option<String>,
    pub description: String,
    pub referer: Option<String>,
    pub speed_limit: u64,
    pub start_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub download_folder: String,
    pub max_active: usize,
    pub connections: usize,
    pub speed_limit: u64,
    pub language: String,
    pub theme: String,
    pub show_completed: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into());
        Self {
            download_folder: Path::new(&home)
                .join("Downloads")
                .join("Current")
                .to_string_lossy()
                .into(),
            max_active: 2,
            connections: 2,
            speed_limit: 0,
            language: "en".into(),
            theme: "light".into(),
            show_completed: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub name: String,
    pub development: bool,
    pub max_active: usize,
    pub max_connections: usize,
    pub paid_features: bool,
    pub billing_available: bool,
}
impl Default for Plan {
    fn default() -> Self {
        let development = cfg!(feature = "development-pro");
        Self {
            name: if development {
                "Development Pro"
            } else {
                "Free"
            }
            .into(),
            development,
            max_active: if development { 8 } else { 2 },
            max_connections: if development { 16 } else { 2 },
            paid_features: development,
            billing_available: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddRequest {
    pub media: Option<crate::media::MediaOptions>,
    pub url: String,
    pub filename: Option<String>,
    pub folder: Option<String>,
    pub later: Option<bool>,
    pub queue: Option<String>,
    pub description: Option<String>,
    pub referer: Option<String>,
    pub expected_sha256: Option<String>,
    pub start_at: Option<String>,
}

impl Job {
    pub fn new(request: AddRequest, settings: &Settings) -> Result<Self> {
        if request.url.len() > 8192
            || request.description.as_ref().is_some_and(|s| s.len() > 4000)
            || request
                .queue
                .as_ref()
                .is_some_and(|s| s.len() > 80 || s.trim().is_empty())
        {
            bail!("The URL, description or queue name exceeds its supported length.");
        }
        let parsed = validate_url(&request.url)?;
        let suggested = parsed
            .path_segments()
            .and_then(|mut s| s.next_back())
            .filter(|s| !s.is_empty())
            .unwrap_or("download");
        let media = match request.media {
            Some(options) => { crate::media::youtube_id(&parsed).ok_or_else(|| anyhow::anyhow!("Use a single YouTube watch, Shorts or video link; playlists and other sites are not supported for media extraction."))?; options.validate()?; Some(options) },
            None if crate::media::youtube_id(&parsed).is_some() => Some(crate::media::MediaOptions::default()),
            None if crate::media::is_youtube_host(&parsed) => bail!("Use a single YouTube video link. Channel and playlist downloads are not supported."),
            None => None,
        };
        let filename = if let Some(ref options) = media {
            let id = crate::media::youtube_id(&parsed).unwrap();
            let title = request
                .filename
                .as_deref()
                .or(request.description.as_deref())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&id);
            let base = safe_filename(title).chars().take(140).collect::<String>();
            let base = base
                .strip_suffix(".mp4")
                .or_else(|| base.strip_suffix(".m4a"))
                .or_else(|| base.strip_suffix(".mp3"))
                .unwrap_or(&base);
            format!("{}.{}", base, options.extension())
        } else {
            safe_filename(request.filename.as_deref().unwrap_or(suggested))
        };
        let folder = request
            .folder
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| settings.download_folder.clone());
        if !Path::new(&folder).is_absolute() {
            bail!("Choose an absolute download folder.");
        }
        let expected_sha256 = request
            .expected_sha256
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_ascii_lowercase());
        if expected_sha256
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
        {
            bail!("SHA-256 must contain exactly 64 hexadecimal characters.");
        }
        if let Some(ref when) = request.start_at {
            chrono::DateTime::parse_from_rfc3339(when)?;
        }
        if let Some(ref referer) = request.referer {
            validate_url(referer)?;
        }
        let category = category_for(&filename).to_string();
        Ok(Self {
            media,
            id: Uuid::new_v4().to_string(),
            url: parsed.into(),
            filename,
            folder,
            category,
            queue: request.queue.unwrap_or_else(|| "Main queue".into()),
            status: if request.later.unwrap_or(false) {
                Status::Paused
            } else {
                Status::Queued
            },
            total: None,
            downloaded: 0,
            speed: 0,
            connections: settings.connections,
            resumable: false,
            validator: None,
            segments: vec![],
            created_at: Utc::now().to_rfc3339(),
            completed_at: None,
            error: None,
            sha256: None,
            expected_sha256,
            description: request.description.unwrap_or_default(),
            referer: request.referer,
            speed_limit: 0,
            start_at: request.start_at,
        })
    }
    pub fn output(&self) -> PathBuf {
        Path::new(&self.folder).join(&self.filename)
    }
}

pub fn validate_url(s: &str) -> Result<Url> {
    let u = Url::parse(s.trim())?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        bail!("Use a complete HTTP or HTTPS URL.");
    }
    if !u.username().is_empty() || u.password().is_some() {
        bail!("Credentials in URLs are not supported. Use a browser-authorized public link.");
    }
    Ok(u)
}

pub fn safe_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(180)
        .collect();
    let trimmed = clean.trim().trim_end_matches(['.', ' ']);
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if trimmed.is_empty() || trimmed == ".." {
        "download".into()
    } else if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.into()
    }
}

pub fn category_for(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "ts" => "Video",
        "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" => "Music",
        "zip" | "7z" | "rar" | "gz" | "tar" => "Archives",
        "exe" | "msi" | "msix" | "dmg" | "apk" | "iso" => "Programs",
        "pdf" | "doc" | "docx" | "txt" | "xlsx" | "csv" | "epub" => "Documents",
        "png" | "jpg" | "jpeg" | "svg" | "gif" | "webp" => "Images",
        _ => "Other",
    }
}

pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("CURRENT_DATA_DIR") {
        return PathBuf::from(p);
    }
    PathBuf::from(
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("HOME"))
            .unwrap_or_else(|| ".".into()),
    )
    .join("CurrentDownloadManager")
}

pub fn split_ranges(total: u64, count: usize) -> Vec<Segment> {
    if total == 0 {
        return vec![];
    }
    let count = (count.max(1) as u64).min(total);
    (0..count)
        .map(|i| Segment {
            index: i as usize,
            start: total / count * i,
            end: if i + 1 == count {
                total
            } else {
                total / count * (i + 1)
            },
            committed: 0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_cover_without_overlap() {
        for n in [1, 2, 17, 1024, u64::MAX / 2] {
            for workers in 1..=16 {
                let r = split_ranges(n, workers);
                assert_eq!(r[0].start, 0);
                assert_eq!(r.last().unwrap().end, n);
                for p in r.windows(2) {
                    assert_eq!(p[0].end, p[1].start);
                }
                assert!(r.iter().all(|s| s.end > s.start));
            }
        }
    }
    #[test]
    fn windows_names_are_safe() {
        assert_eq!(safe_filename("../CON.txt"), ".._CON.txt");
        assert_eq!(safe_filename("CON.txt"), "_CON.txt");
        assert_eq!(safe_filename("a:b?.zip"), "a_b_.zip");
        assert_eq!(safe_filename(".."), "download");
    }
    #[test]
    fn reject_unsafe_url_schemes() {
        assert!(validate_url("file:///C:/Windows/win.ini").is_err());
        assert!(validate_url("https://u:p@example.org/a").is_err());
        assert!(validate_url("https://example.org/a").is_ok());
    }
}
