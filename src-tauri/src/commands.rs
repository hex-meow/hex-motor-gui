//! `#[tauri::command]` surface.
//!
//! Each command acquires the manager mutex, clones the `Arc` out, and drops
//! the guard before awaiting any motor I/O so two commands can run
//! concurrently on the same bus (the underlying [`Cia402Manager`] already
//! serialises overlapping ops via its `inflight_ops` set).

use std::sync::Arc;

use hex_motor::cia402::{Cia402Manager, Cia402ManagerOptions};
use hex_motor::types::MotorMode;
use tauri::State;

use crate::backend;
use crate::dto::{LiveStateDto, MotorInfoDto, MotorModeDto, MotorTargetDto};
use crate::state::AppState;

/// Anything we hand back to the frontend.
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

async fn manager(state: &AppState) -> CmdResult<Arc<Cia402Manager>> {
    state
        .manager()
        .await
        .ok_or_else(|| "not connected: call connect() first".to_string())
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    iface: String,
    our_nid: u8,
    broadcast_heartbeat: bool,
) -> CmdResult<()> {
    let mut guard = state.manager.lock().await;
    if guard.is_some() {
        return Err("already connected; call disconnect() first".into());
    }

    let bus = backend::open_bus(&iface).await.map_err(err)?;
    let opts = Cia402ManagerOptions {
        heartbeat_node_id: our_nid,
        broadcast_heartbeat,
        ..Default::default()
    };
    let mgr = Cia402Manager::new(bus, opts).map_err(err)?;
    log::info!("connected to {iface} as nid 0x{our_nid:02X}");
    *guard = Some(Arc::new(mgr));
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> CmdResult<()> {
    // Stop a running Robot Application first (disables its motors cleanly).
    if let (Some(app), Some(mgr)) = (state.hopea3.lock().await.take(), state.manager().await) {
        app.stop(&mgr).await;
    }
    // Stop any running CSV recorders first so their files flush cleanly.
    for handle in state.drain_logs() {
        crate::logging::stop(handle).await;
    }
    let mut guard = state.manager.lock().await;
    let was = guard.take().is_some();
    if was {
        log::info!("disconnected");
    }
    Ok(())
}

#[tauri::command]
pub async fn is_connected(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(state.manager.lock().await.is_some())
}

#[tauri::command]
pub async fn list_devices(state: State<'_, AppState>) -> CmdResult<Vec<MotorInfoDto>> {
    let Some(mgr) = state.manager().await else {
        return Ok(Vec::new());
    };
    Ok(mgr.list().iter().map(MotorInfoDto::from).collect())
}

#[tauri::command]
pub async fn identify(state: State<'_, AppState>, nid: u8) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.identify(nid).await.map_err(err)
}

#[tauri::command]
pub async fn initialize(state: State<'_, AppState>, nid: u8) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.initialize(nid).await.map_err(err)
}

#[tauri::command]
pub async fn initialize_all(state: State<'_, AppState>) -> CmdResult<Vec<(u8, Option<String>)>> {
    let mgr = manager(&state).await?;
    let results = mgr.initialize_all().await;
    Ok(results
        .into_iter()
        .map(|(nid, r)| (nid, r.err().map(|e| e.to_string())))
        .collect())
}

#[tauri::command]
pub async fn set_mode(
    state: State<'_, AppState>,
    nid: u8,
    mode: MotorModeDto,
) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    let mode: MotorMode = mode.into();
    mgr.set_mode(nid, mode).await.map_err(err)
}

#[tauri::command]
pub async fn set_target(
    state: State<'_, AppState>,
    nid: u8,
    target: MotorTargetDto,
) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.set_target(nid, target.into()).await.map_err(err)
}

#[tauri::command]
pub async fn set_max_torque(
    state: State<'_, AppState>,
    nid: u8,
    permille: u16,
) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.set_max_torque(nid, permille).await.map_err(err)
}

#[tauri::command]
pub async fn disable(state: State<'_, AppState>, nid: u8) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.disable(nid).await.map_err(err)
}

#[tauri::command]
pub async fn clear_error(state: State<'_, AppState>, nid: u8) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.clear_error(nid).await.map_err(err)
}

/// Change a motor's Node-ID (0x2001:01 + save). Power-cycle to apply.
#[tauri::command]
pub async fn change_node_id(
    state: State<'_, AppState>,
    nid: u8,
    new_id: u8,
) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.change_node_id(nid, new_id).await.map_err(err)
}

/// Drop offline motor entries from the discovery list (batch ID-change cleanup).
#[tauri::command]
pub async fn forget_offline(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(mgr) = state.manager().await {
        mgr.forget_offline();
    }
    Ok(())
}

/// Set this motor's current rotor position to `pos` (Rev, -0.5..0.5) via the
/// 0x3001 user-position-preset. Motor must be in Switch On Disabled (it is on
/// fresh power-up). See huayi.md §3.6.
#[tauri::command]
pub async fn set_position_preset(
    state: State<'_, AppState>,
    nid: u8,
    pos: f32,
) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    mgr.set_position_preset(nid, pos).await.map_err(err)
}

/// Read 0x6064 (actual position, Rev) once, on demand.
#[tauri::command]
pub async fn read_position(state: State<'_, AppState>, nid: u8) -> CmdResult<f32> {
    let mgr = manager(&state).await?;
    mgr.read_position(nid).await.map_err(err)
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>, nid: u8) -> CmdResult<LiveStateDto> {
    let mgr = manager(&state).await?;
    let snap = mgr.status(nid);
    Ok((&snap).into())
}

/// Start recording this motor's full-rate stream to a fresh CSV file. Returns
/// the absolute path. If a recorder is already running for this nid, it is
/// stopped and replaced (so the toggle is idempotent).
#[tauri::command]
pub async fn start_log(state: State<'_, AppState>, nid: u8) -> CmdResult<String> {
    let mgr = manager(&state).await?;
    if let Some(existing) = state.take_log(nid) {
        crate::logging::stop(existing).await;
    }
    let handle = crate::logging::start(mgr, nid).await.map_err(err)?;
    let path = handle.path.clone();
    state.logs.lock().unwrap().insert(nid, handle);
    log::info!("started CSV log for nid 0x{nid:02X}: {path}");
    Ok(path)
}

/// Stop the CSV recorder for this motor (flush + close). No-op if none running.
#[tauri::command]
pub async fn stop_log(state: State<'_, AppState>, nid: u8) -> CmdResult<()> {
    if let Some(handle) = state.take_log(nid) {
        crate::logging::stop(handle).await;
        log::info!("stopped CSV log for nid 0x{nid:02X}");
    }
    Ok(())
}

// ───────────────────────── HopeA3 Robot Application ─────────────────────────

/// Initialize the three HopeA3 motors and start the 500 Hz PV control loop.
#[tauri::command]
pub async fn hopea3_start(state: State<'_, AppState>) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    let mut guard = state.hopea3.lock().await;
    if guard.is_some() {
        return Err("HopeA3 already running; stop it first".into());
    }
    let app = crate::hopea3::Hopea3::start(mgr, &state.hopea3_init)
        .await
        .map_err(err)?;
    *guard = Some(app);
    log::info!("HopeA3 started");
    Ok(())
}

/// Poll init progress while `hopea3_start` runs (which motor / attempt).
#[tauri::command]
pub async fn hopea3_init_progress(
    state: State<'_, AppState>,
) -> CmdResult<crate::hopea3::InitProgress> {
    Ok(state.hopea3_init.lock().unwrap().clone())
}

/// Stop the control loop and disable all HopeA3 motors. No-op if not running.
#[tauri::command]
pub async fn hopea3_stop(state: State<'_, AppState>) -> CmdResult<()> {
    let app = state.hopea3.lock().await.take();
    if let Some(app) = app {
        let mgr = manager(&state).await?;
        app.stop(&mgr).await;
        log::info!("HopeA3 stopped");
    }
    Ok(())
}

/// Set the commanded body twist (m/s, m/s, rad/s). Clamped to limits, never errored.
#[tauri::command]
pub async fn hopea3_set_cmd(
    state: State<'_, AppState>,
    vx: f64,
    vy: f64,
    wz: f64,
) -> CmdResult<()> {
    if let Some(app) = state.hopea3.lock().await.as_ref() {
        app.set_cmd(vx, vy, wz);
    }
    Ok(())
}

/// Set per-motor max torque (‰ of peak), indexed [motor1, motor2, motor3].
#[tauri::command]
pub async fn hopea3_set_max_torque(
    state: State<'_, AppState>,
    permille: [u16; 3],
) -> CmdResult<()> {
    if let Some(app) = state.hopea3.lock().await.as_ref() {
        app.set_max_torque(permille);
    }
    Ok(())
}

/// Set per-motor MIT velocity gain KD (SI, Nm·s/rad), indexed [motor1,2,3].
#[tauri::command]
pub async fn hopea3_set_kd(state: State<'_, AppState>, kd_si: [f64; 3]) -> CmdResult<()> {
    if let Some(app) = state.hopea3.lock().await.as_ref() {
        app.set_kd(kd_si);
    }
    Ok(())
}

/// Adjust the velocity limits (max linear m/s magnitude, max angular rad/s).
#[tauri::command]
pub async fn hopea3_set_limits(
    state: State<'_, AppState>,
    max_linear: f64,
    max_angular: f64,
) -> CmdResult<()> {
    if let Some(app) = state.hopea3.lock().await.as_ref() {
        app.set_limits(max_linear, max_angular);
    }
    Ok(())
}

/// Clear CiA402 faults on all three HopeA3 motors (best-effort). Useful before
/// starting if a previous run left them in a heartbeat-lost / fault state.
#[tauri::command]
pub async fn hopea3_clear_errors(state: State<'_, AppState>) -> CmdResult<()> {
    let mgr = manager(&state).await?;
    crate::hopea3::clear_errors(&mgr).await;
    Ok(())
}

/// Reset the dead-reckoned odometry pose to the origin.
#[tauri::command]
pub async fn hopea3_reset_odom(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(app) = state.hopea3.lock().await.as_ref() {
        app.reset_odom();
    }
    Ok(())
}

/// Poll the current chassis state (pose, twist, per-motor status).
#[tauri::command]
pub async fn hopea3_get_state(
    state: State<'_, AppState>,
) -> CmdResult<crate::hopea3::Hopea3State> {
    Ok(match state.hopea3.lock().await.as_ref() {
        Some(app) => app.state(),
        None => crate::hopea3::Hopea3State::default(),
    })
}
