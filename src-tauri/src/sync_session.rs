//! Registry of live sync sessions keyed by pair_id_hex. The watcher
//! fan-out pushes JSON frames to all registered senders; the session
//! task forwards them to the WS client.

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// One registered session: its id (for `unregister`) and the channel the
/// watcher fan-out pushes frames into.
type Session = (usize, mpsc::Sender<serde_json::Value>);

pub struct SyncSessionRegistry {
    senders: Mutex<HashMap<String, Vec<Session>>>,
    next_id: Mutex<usize>,
}

impl SyncSessionRegistry {
    pub fn new() -> Self {
        Self {
            senders: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    /// Register a sender; returns a session ID for later unregistration.
    pub fn register(
        &self,
        pair_id_hex: &str,
        tx: mpsc::Sender<serde_json::Value>,
    ) -> usize {
        let id = {
            let mut n = self.next_id.lock().unwrap();
            let v = *n;
            *n += 1;
            v
        };
        self.senders
            .lock()
            .unwrap()
            .entry(pair_id_hex.to_string())
            .or_default()
            .push((id, tx));
        id
    }

    pub fn unregister(&self, pair_id_hex: &str, session_id: usize) {
        let mut guard = self.senders.lock().unwrap();
        if let Some(vec) = guard.get_mut(pair_id_hex) {
            vec.retain(|(id, _)| *id != session_id);
        }
    }

    /// Fan out a frame to all sessions for this pair. Dead senders are pruned.
    pub fn push(&self, pair_id_hex: &str, frame: serde_json::Value) {
        let mut guard = self.senders.lock().unwrap();
        if let Some(vec) = guard.get_mut(pair_id_hex) {
            vec.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
        }
    }
}

impl Default for SyncSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}
