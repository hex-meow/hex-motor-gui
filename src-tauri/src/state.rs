//! Tauri-managed app state.
//!
//! Holds at most one [`Cia402Manager`] at a time (one CAN bus per app
//! lifetime). All commands acquire the async mutex, clone the `Arc` out of
//! the guard, and drop the guard before awaiting any motor I/O so callers
//! can run concurrently.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use hex_motor::cia402::Cia402Manager;
use tokio::sync::Mutex;

use crate::hopea3::{Hopea3, InitProgress};
use crate::logging::LogHandle;

#[derive(Default)]
pub struct AppState {
    pub manager: Mutex<Option<Arc<Cia402Manager>>>,
    /// Active CSV recorders, keyed by node id. Inserted by `start_log`,
    /// removed by `stop_log` / `disconnect`. A `std` mutex is fine: we only
    /// ever insert/remove under it, never await while holding it.
    pub logs: StdMutex<HashMap<u8, LogHandle>>,
    /// The running HopeA3 Robot Application, if started. At most one at a time
    /// (it owns the 500 Hz control loop on the single bus).
    pub hopea3: Mutex<Option<Hopea3>>,
    /// Live init progress for the UI to poll while `hopea3_start` runs. A `std`
    /// mutex: only short, await-free updates happen under it.
    pub hopea3_init: StdMutex<InitProgress>,
}

impl AppState {
    /// Convenience: clone the current manager Arc out of the mutex, or
    /// return `None` if not connected. The mutex is released before the
    /// caller awaits.
    pub async fn manager(&self) -> Option<Arc<Cia402Manager>> {
        self.manager.lock().await.clone()
    }

    /// Take a log handle out of the map (for stopping), if present.
    pub fn take_log(&self, nid: u8) -> Option<LogHandle> {
        self.logs.lock().unwrap().remove(&nid)
    }

    /// Drain all log handles (used on disconnect).
    pub fn drain_logs(&self) -> Vec<LogHandle> {
        self.logs.lock().unwrap().drain().map(|(_, h)| h).collect()
    }
}
