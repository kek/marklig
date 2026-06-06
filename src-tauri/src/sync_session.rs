//! Session registry — full implementation in Task 4.
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;

pub struct SyncSessionRegistry {
    senders: Mutex<HashMap<String, Vec<(usize, mpsc::Sender<serde_json::Value>)>>>,
    next_id: Mutex<usize>,
}

impl SyncSessionRegistry {
    pub fn new() -> Self {
        Self {
            senders: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    pub fn push(&self, _pair_id_hex: &str, _frame: serde_json::Value) {
        // Implemented in Task 4
    }
}

impl Default for SyncSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}
