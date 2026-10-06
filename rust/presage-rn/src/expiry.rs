//! Disappearing messages.
//!
//! A Signal chat can carry a timer. Once a message has existed for that long
//! (counted from when it was sent, or for incoming messages from when it was
//! read) every device deletes it on its own; nothing is coordinated through
//! the server. Like the official clients, Hush can only do this while it runs:
//! a scan at startup removes whatever ran out while we were closed, and a
//! single task sleeps until the next message is due.
//!
//! presage records the timer for 1:1 chats on the contact, but its SQLite
//! store drops group timers, so we track every chat's timer here as well.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use presage::libsignal_service::content::ContentBody;
use presage::proto::{data_message, DataMessage};
use serde::{Deserialize, Serialize};
use tracing::warn;

/// `DataMessage.flags` bit for a timer change notice.
pub(crate) const EXPIRATION_TIMER_UPDATE: u32 = data_message::Flags::ExpirationTimerUpdate as u32;

/// The latest timer we've seen for a chat, and the timestamp of the message
/// that carried it (so an older message arriving late can't roll it back).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct ChannelTimer {
    seconds: u32,
    set_at: u64,
}

pub(crate) struct Expiry {
    data_dir: PathBuf,
    /// channel_id → timer, persisted to expire_timers.json. Kept even after
    /// every message in a chat has expired, which is exactly when we can no
    /// longer re-derive it from the messages themselves.
    timers: RwLock<HashMap<String, ChannelTimer>>,
    /// "channel_id/timestamp" → when we read that incoming message, persisted
    /// to expiry_starts.json. Incoming countdowns start on read, and the read
    /// time can't be recovered from the store.
    starts: RwLock<HashMap<String, u64>>,
    /// Pending deletions as (due_ms, channel_id, timestamp), soonest first.
    queue: Mutex<BTreeSet<(u64, String, u64)>>,
    /// Wakes the expiry task when something due sooner gets scheduled.
    pub(crate) wake: tokio::sync::Notify,
    /// Set once the expiry task has been spawned.
    pub(crate) running: AtomicBool,
    /// Bumped by `stop`; a running task exits once it no longer matches.
    pub(crate) generation: AtomicU64,
}

impl Expiry {
    pub(crate) fn load(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            timers: RwLock::new(load_json(data_dir, "expire_timers.json")),
            starts: RwLock::new(load_json(data_dir, "expiry_starts.json")),
            queue: Mutex::new(BTreeSet::new()),
            wake: tokio::sync::Notify::new(),
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    /// The timer we've tracked for a chat, if we've seen one.
    pub(crate) fn tracked_timer(&self, channel_id: &str) -> Option<u32> {
        self.timers.read().get(channel_id).map(|t| t.seconds)
    }

    /// Record the timer carried by a message in `channel_id` sent at `ts`.
    /// Returns true when this changes the chat's timer.
    pub(crate) fn observe_timer(&self, channel_id: &str, ts: u64, seconds: u32) -> bool {
        let mut timers = self.timers.write();
        let previous = timers.get(channel_id).copied();
        if previous.is_some_and(|p| ts < p.set_at) {
            return false;
        }
        timers.insert(channel_id.to_string(), ChannelTimer { seconds, set_at: ts });
        let changed = previous.map(|p| p.seconds).unwrap_or(0) != seconds;
        if previous.map(|p| p.seconds) != Some(seconds) {
            save_json(&self.data_dir, "expire_timers.json", &*timers);
        }
        changed
    }

    /// When the incoming message at `ts` was read here, if we recorded it.
    pub(crate) fn read_at(&self, channel_id: &str, ts: u64) -> Option<u64> {
        self.starts.read().get(&start_key(channel_id, ts)).copied()
    }

    /// Start the countdown for incoming messages read at `read_at`. Messages
    /// that already have a start keep it.
    pub(crate) fn record_reads(&self, channel_id: &str, timestamps: &[u64], read_at: u64) {
        if timestamps.is_empty() {
            return;
        }
        let mut starts = self.starts.write();
        for ts in timestamps {
            starts.entry(start_key(channel_id, *ts)).or_insert(read_at);
        }
        save_json(&self.data_dir, "expiry_starts.json", &*starts);
    }

    /// Queue a message for deletion at `due`.
    pub(crate) fn schedule(&self, channel_id: &str, ts: u64, due: u64) {
        let is_soonest = {
            let mut queue = self.queue.lock();
            let entry = (due, channel_id.to_string(), ts);
            let soonest = queue.first().map_or(true, |first| entry < *first);
            queue.insert(entry);
            soonest
        };
        if is_soonest {
            self.wake.notify_one();
        }
    }

    /// Remove and return every queued message due at or before `now`.
    pub(crate) fn take_due(&self, now: u64) -> Vec<(String, u64)> {
        let mut queue = self.queue.lock();
        let mut due = Vec::new();
        while let Some(first) = queue.first() {
            if first.0 > now {
                break;
            }
            let (_, channel_id, ts) = queue.pop_first().unwrap();
            due.push((channel_id, ts));
        }
        due
    }

    pub(crate) fn next_due(&self) -> Option<u64> {
        self.queue.lock().first().map(|(due, _, _)| *due)
    }

    /// Drop the bookkeeping for messages that have been deleted.
    pub(crate) fn forget(&self, channel_id: &str, timestamps: &[u64]) {
        let mut starts = self.starts.write();
        let before = starts.len();
        for ts in timestamps {
            starts.remove(&start_key(channel_id, *ts));
        }
        if starts.len() != before {
            save_json(&self.data_dir, "expiry_starts.json", &*starts);
        }
    }

    /// Tell the expiry task to exit (used when unlinking).
    pub(crate) fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.wake.notify_one();
    }

    /// Forget everything (used when unlinking).
    pub(crate) fn clear(&self) {
        self.timers.write().clear();
        self.starts.write().clear();
        self.queue.lock().clear();
        let _ = std::fs::remove_file(self.data_dir.join("expire_timers.json"));
        let _ = std::fs::remove_file(self.data_dir.join("expiry_starts.json"));
    }
}

/// When a message disappears, in ms since epoch. None if it has no timer or
/// is an incoming message nobody has read yet.
pub(crate) fn expires_at(
    expiry: &Expiry,
    channel_id: &str,
    ts: u64,
    timer_secs: u32,
    is_outgoing: bool,
    last_read_ts: u64,
) -> Option<u64> {
    if timer_secs == 0 {
        return None;
    }
    let start = if is_outgoing {
        ts
    } else if let Some(read_at) = expiry.read_at(channel_id, ts) {
        read_at
    } else if ts <= last_read_ts {
        // Read before we tracked read times (or on another device while we
        // were closed). The receive time is the earliest it could have been
        // read, so count from there.
        ts
    } else {
        return None;
    };
    Some(start.saturating_add(timer_secs as u64 * 1000))
}

/// The DataMessage a stored or received body carries, if any.
pub(crate) fn data_message_of(body: &ContentBody) -> Option<&DataMessage> {
    match body {
        ContentBody::DataMessage(dm) => Some(dm),
        ContentBody::EditMessage(edit) => edit.data_message.as_ref(),
        ContentBody::SynchronizeMessage(sync) => {
            let sent = sync.sent.as_ref()?;
            sent.message
                .as_ref()
                .or_else(|| sent.edit_message.as_ref().and_then(|e| e.data_message.as_ref()))
        }
        _ => None,
    }
}

/// The timer a message carries, if it sets one at all.
pub(crate) fn expire_timer_of(body: &ContentBody) -> Option<u32> {
    data_message_of(body).and_then(|dm| dm.expire_timer)
}

/// True for "X set the timer to …" notices. These carry the new timer but,
/// as in the official clients, never disappear themselves.
pub(crate) fn is_timer_update(dm: &DataMessage) -> bool {
    dm.flags.unwrap_or(0) & EXPIRATION_TIMER_UPDATE != 0
}

/// The timer that makes a stored message disappear: 0 for messages without
/// one and for timer-change notices.
pub(crate) fn disappearing_timer_of(body: &ContentBody) -> u32 {
    match data_message_of(body) {
        Some(dm) if !is_timer_update(dm) => dm.expire_timer.unwrap_or(0),
        _ => 0,
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn start_key(channel_id: &str, ts: u64) -> String {
    format!("{channel_id}/{ts}")
}

fn load_json<T: serde::de::DeserializeOwned + Default>(data_dir: &Path, name: &str) -> T {
    std::fs::read_to_string(data_dir.join(name))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_json<T: Serialize>(data_dir: &Path, name: &str, value: &T) {
    match serde_json::to_string(value) {
        Ok(json) => {
            if let Err(e) = std::fs::write(data_dir.join(name), json) {
                warn!("Failed to write {}: {}", name, e);
            }
        }
        Err(e) => warn!("Failed to serialize {}: {}", name, e),
    }
}

/// Delete messages straight from the store with SQLite's secure_delete on, so
/// the freed pages are zeroed instead of leaving the text readable in the file.
/// presage's own delete goes through its pool, where we can't set the pragma.
pub(crate) fn secure_delete_messages(
    store_path: &Path,
    thread_key: ThreadKey,
    timestamps: &[u64],
) -> rusqlite::Result<usize> {
    let mut conn = rusqlite::Connection::open(store_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "secure_delete", true)?;
    let tx = conn.transaction()?;
    let mut deleted = 0;
    {
        let thread_id: Option<i64> = match thread_key {
            ThreadKey::Group(key) => tx.query_row(
                "SELECT id FROM threads WHERE group_master_key = ?1",
                [&key],
                |row| row.get(0),
            ),
            ThreadKey::Contact(uuid) => tx.query_row(
                "SELECT id FROM threads WHERE recipient_id = ?1",
                [&uuid],
                |row| row.get(0),
            ),
        }
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })?;
        if let Some(thread_id) = thread_id {
            let mut stmt =
                tx.prepare("DELETE FROM thread_messages WHERE ts = ?1 AND thread_id = ?2")?;
            for ts in timestamps {
                deleted += stmt.execute(rusqlite::params![*ts as i64, thread_id])?;
            }
        }
    }
    tx.commit()?;
    truncate_wal(&conn);
    Ok(deleted)
}

/// Rebuild the database file so no free page still holds old message text,
/// including leftovers from deletes made without secure_delete (presage's own).
/// Run once after the startup cleanup; it's quick at Hush's database sizes.
pub(crate) fn compact(store_path: &Path) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open(store_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch("VACUUM")?;
    truncate_wal(&conn);
    Ok(())
}

/// Checkpoint the WAL and cut it to zero length. Until the log is reset it
/// keeps the pre-delete copies of every page, text included. Best-effort: if
/// presage is mid-read we leave it, and the next delete tries again.
fn truncate_wal(conn: &rusqlite::Connection) {
    // Keep the wait short; a TRUNCATE checkpoint holds up writers while it waits
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));
    if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())) {
        warn!("Couldn't truncate the WAL after deleting messages: {}", e);
    }
}

/// How a thread is keyed in presage's `threads` table.
pub(crate) enum ThreadKey {
    /// The group master key
    Group(Vec<u8>),
    /// The contact's UUID as 16 raw bytes
    Contact(Vec<u8>),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hush-expiry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn outgoing_counts_from_send_and_incoming_from_read() {
        let expiry = Expiry::load(&temp_dir("start"));
        // Sent at 1000 with a 60s timer
        assert_eq!(expires_at(&expiry, "c", 1000, 60, true, 0), Some(61_000));
        // Incoming and unread: no countdown yet
        assert_eq!(expires_at(&expiry, "c", 1000, 60, false, 0), None);
        // Read later here: counts from the read
        expiry.record_reads("c", &[1000], 50_000);
        assert_eq!(expires_at(&expiry, "c", 1000, 60, false, 0), Some(110_000));
        // Read with no recorded time (before tracking): counts from receipt
        assert_eq!(expires_at(&expiry, "c", 2000, 60, false, 5000), Some(62_000));
        // No timer, never disappears
        assert_eq!(expires_at(&expiry, "c", 1000, 0, true, 0), None);
    }

    #[test]
    fn older_messages_cannot_roll_the_timer_back() {
        let dir = temp_dir("observe");
        let expiry = Expiry::load(&dir);
        assert!(expiry.observe_timer("c", 100, 3600));
        assert!(!expiry.observe_timer("c", 50, 0));
        assert_eq!(expiry.tracked_timer("c"), Some(3600));
        assert!(!expiry.observe_timer("c", 200, 3600));
        assert!(expiry.observe_timer("c", 300, 0));
        // Survives a restart
        assert_eq!(Expiry::load(&dir).tracked_timer("c"), Some(0));
    }

    #[test]
    fn queue_hands_out_due_messages_in_order() {
        let expiry = Expiry::load(&temp_dir("queue"));
        expiry.schedule("a", 1, 300);
        expiry.schedule("b", 2, 100);
        expiry.schedule("a", 3, 200);
        assert_eq!(expiry.next_due(), Some(100));
        assert_eq!(expiry.take_due(250), vec![("b".to_string(), 2), ("a".to_string(), 3)]);
        assert_eq!(expiry.next_due(), Some(300));
    }

    #[test]
    fn secure_delete_zeroes_the_message_text() {
        let dir = temp_dir("delete");
        let db = dir.join("signal.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (id INTEGER PRIMARY KEY AUTOINCREMENT, group_master_key BLOB UNIQUE, recipient_id TEXT UNIQUE);
             CREATE TABLE thread_messages (ts INTEGER NOT NULL, thread_id INTEGER NOT NULL, content_body BLOB NOT NULL, PRIMARY KEY (ts, thread_id));",
        )
        .unwrap();
        let uuid = [7u8; 16];
        conn.execute("INSERT INTO threads (recipient_id) VALUES (?1)", [&uuid[..]]).unwrap();
        for (ts, text) in [(1i64, "SECRET-ONE"), (2, "KEEP-THIS")] {
            conn.execute(
                "INSERT INTO thread_messages VALUES (?1, 1, ?2)",
                rusqlite::params![ts, text.repeat(50).into_bytes()],
            )
            .unwrap();
        }
        drop(conn);

        let deleted = secure_delete_messages(&db, ThreadKey::Contact(uuid.to_vec()), &[1]).unwrap();
        assert_eq!(deleted, 1);

        let conn = rusqlite::Connection::open(&db).unwrap();
        let left: Vec<i64> = conn
            .prepare("SELECT ts FROM thread_messages")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(left, vec![2]);
        drop(conn);

        let mut bytes = std::fs::read(&db).unwrap();
        bytes.extend(std::fs::read(dir.join("signal.db-wal")).unwrap_or_default());
        let contains = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
        assert!(!contains(b"SECRET-ONE"), "deleted text is still in the file");
        assert!(contains(b"KEEP-THIS"));
    }
}
