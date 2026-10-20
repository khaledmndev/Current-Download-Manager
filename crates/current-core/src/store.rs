use crate::{Job, Settings, Status};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct Store {
    db: Mutex<Connection>,
    pub root: PathBuf,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join("parts"))?;
        let db = Connection::open(root.join("current.sqlite3"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, created TEXT NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL); PRAGMA user_version=1;")?;
        let store = Self {
            db: Mutex::new(db),
            root: root.into(),
        };
        for mut job in store.list()? {
            if job.status.active() {
                job.status = Status::Paused;
                job.speed = 0;
                job.error = Some(
                    "Recovered after the background process stopped. Resume to continue.".into(),
                );
                store.save(&job)?;
            }
        }
        Ok(store)
    }
    pub fn list(&self) -> Result<Vec<Job>> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT record FROM jobs ORDER BY created DESC")?;
        let mut result = vec![];
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            result.push(serde_json::from_str(&row?)?);
        }
        Ok(result)
    }
    pub fn get(&self, id: &str) -> Result<Job> {
        let raw: String = self.db.lock().unwrap().query_row(
            "SELECT record FROM jobs WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn save(&self, job: &Job) -> Result<()> {
        self.db.lock().unwrap().execute("INSERT INTO jobs(id,created,record) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET record=excluded.record",params![job.id,job.created_at,serde_json::to_string(job)?])?;
        Ok(())
    }
    pub fn update(&self, id: &str, change: impl FnOnce(&mut Job)) -> Result<Job> {
        let db = self.db.lock().unwrap();
        let raw: String =
            db.query_row("SELECT record FROM jobs WHERE id=?1", [id], |r| r.get(0))?;
        let mut job: Job = serde_json::from_str(&raw)?;
        change(&mut job);
        db.execute(
            "UPDATE jobs SET record=?2 WHERE id=?1",
            params![id, serde_json::to_string(&job)?],
        )?;
        Ok(job)
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let job = self.get(id)?;
        if job.status.active() {
            bail!("Pause the download before removing it.");
        }
        self.db
            .lock()
            .unwrap()
            .execute("DELETE FROM jobs WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Settings> {
        let db = self.db.lock().unwrap();
        let raw = db.query_row("SELECT record FROM settings WHERE id=1", [], |r| {
            r.get::<_, String>(0)
        });
        match raw {
            Ok(s) => Ok(serde_json::from_str(&s)?),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Settings::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        self.db.lock().unwrap().execute("INSERT INTO settings(id,record) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET record=excluded.record",[serde_json::to_string(s)?])?;
        Ok(())
    }
    pub fn parts(&self, id: &str) -> PathBuf {
        self.root.join("parts").join(id)
    }
}
