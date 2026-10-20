use current_core::*;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Fixture {
    url: String,
    bytes: Arc<Vec<u8>>,
    changed: Arc<AtomicBool>,
}
async fn fixture(ignore_ranges: bool, slow: bool) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let bytes = Arc::new(
        (0..8 * 1024 * 1024)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>(),
    );
    let changed = Arc::new(AtomicBool::new(false));
    let data = bytes.clone();
    let changed_copy = changed.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let data = data.clone();
            let changed = changed_copy.clone();
            tokio::spawn(async move {
                let mut request = vec![];
                let mut buffer = [0u8; 1024];
                loop {
                    let Ok(n) = socket.read(&mut buffer).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..n]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                    if request.len() > 32768 {
                        return;
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let range = text
                    .lines()
                    .find(|s| s.to_ascii_lowercase().starts_with("range:"))
                    .and_then(|s| s.split("bytes=").nth(1))
                    .and_then(|s| s.split_once('-'))
                    .and_then(|(a, b)| {
                        Some((
                            a.trim().parse::<usize>().ok()?,
                            b.trim().parse::<usize>().ok()?,
                        ))
                    });
                let probe = range == Some((0, 0));
                let use_range = range.is_some() && (!ignore_ranges || probe);
                let (start, end) = if use_range {
                    range.unwrap()
                } else {
                    (0, data.len() - 1)
                };
                let etag = if changed.load(Ordering::Relaxed) {
                    "\"changed\""
                } else {
                    "\"fixture-v1\""
                };
                let header = if use_range {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\n",
                        data.len()
                    )
                } else {
                    "HTTP/1.1 200 OK\r\n".into()
                };
                let header = format!(
                    "{header}Content-Length: {}\r\nETag: {etag}\r\nConnection: close\r\n\r\n",
                    end - start + 1
                );
                if socket.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                for chunk in data[start..=end].chunks(16384) {
                    if socket.write_all(chunk).await.is_err() {
                        return;
                    }
                    if slow && !probe {
                        tokio::time::sleep(Duration::from_millis(8)).await;
                    }
                }
            });
        }
    });
    Fixture {
        url: format!("http://{address}/fixture.bin"),
        bytes,
        changed,
    }
}

fn request(url: &str, folder: &std::path::Path) -> AddRequest {
    AddRequest {
        media: None,
        url: url.into(),
        filename: None,
        folder: Some(folder.to_string_lossy().into()),
        later: None,
        queue: None,
        description: None,
        referer: None,
        expected_sha256: None,
        start_at: None,
    }
}
async fn wait_for(engine: &Engine, id: &str, predicate: impl Fn(&Job) -> bool) -> Job {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let j = engine.store.get(id).unwrap();
            if predicate(&j) {
                return j;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("job state timed out")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_download_is_byte_exact_and_does_not_overwrite() {
    let fixture = fixture(false, false).await;
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store::open(&temp.path().join("data")).unwrap()).unwrap();
    std::fs::create_dir_all(temp.path().join("out")).unwrap();
    std::fs::write(temp.path().join("out/fixture.bin"), b"existing").unwrap();
    let job = engine
        .add(request(&fixture.url, &temp.path().join("out")))
        .unwrap();
    assert_eq!(job.filename, "fixture (1).bin");
    let scheduler = tokio::spawn(engine.clone().scheduler());
    let done = wait_for(&engine, &job.id, |j| {
        matches!(j.status, Status::Completed | Status::Failed)
    })
    .await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(std::fs::read(done.output()).unwrap(), *fixture.bytes);
    assert_eq!(
        done.sha256.unwrap(),
        hex::encode(Sha256::digest(&*fixture.bytes))
    );
    assert_eq!(
        std::fs::read(temp.path().join("out/fixture.bin")).unwrap(),
        b"existing"
    );
    scheduler.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_and_resume_keeps_committed_ranges() {
    let fixture = fixture(false, true).await;
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store::open(&temp.path().join("data")).unwrap()).unwrap();
    let job = engine
        .add(request(&fixture.url, &temp.path().join("out")))
        .unwrap();
    let scheduler = tokio::spawn(engine.clone().scheduler());
    wait_for(&engine, &job.id, |j| j.downloaded > 100_000).await;
    engine.action(&job.id, "pause").unwrap();
    let paused = wait_for(&engine, &job.id, |j| j.status == Status::Paused).await;
    assert!(paused.downloaded > 0);
    assert!(paused.downloaded < paused.total.unwrap());
    // Paused is persisted before the scheduler releases its active slot.
    tokio::time::sleep(Duration::from_millis(100)).await;
    engine.action(&job.id, "resume").unwrap();
    let done = wait_for(&engine, &job.id, |j| {
        matches!(j.status, Status::Completed | Status::Failed)
    })
    .await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(std::fs::read(done.output()).unwrap(), *fixture.bytes);
    scheduler.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changed_etag_rejects_resume_and_preserves_parts() {
    let fixture = fixture(false, true).await;
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store::open(&temp.path().join("data")).unwrap()).unwrap();
    let job = engine
        .add(request(&fixture.url, &temp.path().join("out")))
        .unwrap();
    let scheduler = tokio::spawn(engine.clone().scheduler());
    wait_for(&engine, &job.id, |j| j.downloaded > 100_000).await;
    engine.action(&job.id, "pause").unwrap();
    let paused = wait_for(&engine, &job.id, |j| j.status == Status::Paused).await;
    fixture.changed.store(true, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(100)).await;
    engine.action(&job.id, "resume").unwrap();
    let failed = wait_for(&engine, &job.id, |j| j.status == Status::Failed).await;
    assert!(failed.error.unwrap().contains("changed"));
    assert_eq!(failed.downloaded, paused.downloaded);
    assert!(engine.store.parts(&job.id).exists());
    assert!(!job.output().exists());
    scheduler.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn server_ignoring_worker_ranges_falls_back_without_appending_full_bodies() {
    let fixture = fixture(true, false).await;
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store::open(&temp.path().join("data")).unwrap()).unwrap();
    let job = engine
        .add(request(&fixture.url, &temp.path().join("out")))
        .unwrap();
    let scheduler = tokio::spawn(engine.clone().scheduler());
    let failed = wait_for(&engine, &job.id, |j| {
        matches!(j.status, Status::Completed | Status::Failed)
    })
    .await;
    assert_eq!(failed.status, Status::Completed, "{:?}", failed.error);
    assert_eq!(std::fs::read(job.output()).unwrap(), *fixture.bytes);
    scheduler.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_expected_hash_blocks_output() {
    let fixture = fixture(false, false).await;
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store::open(&temp.path().join("data")).unwrap()).unwrap();
    let mut req = request(&fixture.url, &temp.path().join("out"));
    req.expected_sha256 = Some("0".repeat(64));
    let job = engine.add(req).unwrap();
    let scheduler = tokio::spawn(engine.clone().scheduler());
    let failed = wait_for(&engine, &job.id, |j| j.status == Status::Failed).await;
    assert!(failed.error.unwrap().contains("SHA-256"));
    assert!(!job.output().exists());
    assert!(engine.store.parts(&job.id).exists());
    scheduler.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fully_committed_parts_finalize_without_contacting_an_offline_source() {
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store::open(&temp.path().join("data")).unwrap()).unwrap();
    let mut job = engine
        .add(request(
            "http://127.0.0.1:1/offline.bin",
            &temp.path().join("out"),
        ))
        .unwrap();
    let data = b"all bytes were already durably downloaded";
    job.total = Some(data.len() as u64);
    job.downloaded = data.len() as u64;
    job.segments = split_ranges(data.len() as u64, 1);
    job.segments[0].committed = data.len() as u64;
    std::fs::create_dir_all(engine.store.parts(&job.id)).unwrap();
    std::fs::write(engine.store.parts(&job.id).join("0.part"), data).unwrap();
    engine.store.save(&job).unwrap();
    let scheduler = tokio::spawn(engine.clone().scheduler());
    let done = wait_for(&engine, &job.id, |j| {
        matches!(j.status, Status::Completed | Status::Failed)
    })
    .await;
    assert_eq!(done.status, Status::Completed, "{:?}", done.error);
    assert_eq!(std::fs::read(done.output()).unwrap(), data);
    scheduler.abort();
}
