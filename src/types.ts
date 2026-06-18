// TS mirrors of the serde DTOs in src-tauri/src/dto.rs.

export type MotorMode =
  | "ProfilePosition"
  | "ProfileVelocity"
  | "Torque"
  | "Mit";

export interface MotorIdentity {
  node_id: number;
  vendor_id: number;
  product_code: number;
  revision_number: number;
  serial_number: number;
  product_name: string | null;
}

export type Lifecycle =
  | { kind: "Unknown" }
  | { kind: "Identified" }
  | { kind: "Initializing" }
  | { kind: "Initialized" }
  | { kind: "NeedsReinit"; reason: string };

export type Logic =
  | { state: "Disabled" }
  | { state: "Enabled"; mode: MotorMode }
  | { state: "Error"; kind: string; raw_code: number };

export type NmtState =
  | "BootUp"
  | "Stopped"
  | "Operational"
  | "PreOperational";

export interface MotorInfo {
  node_id: number;
  friendly_name: string;
  identity: MotorIdentity | null;
  lifecycle: Lifecycle;
  online: boolean;
  logic: Logic | null;
  nmt_state: NmtState | null;
  is_ready: boolean;
  can_initialize: boolean;
  peak_torque_nm: number | null;
}

export interface Measurements {
  position_rev: number | null;
  velocity_rev_per_s: number | null;
  torque_nm: number | null;
  driver_temp_c: number | null;
  motor_temp_c: number | null;
  status_word: number | null;
  mode_display: number | null;
  error_register: number | null;
  timestamp_us: number | null;
}

export interface Connection {
  online: boolean;
  nmt_state: NmtState | null;
  has_heartbeat: boolean;
  has_tpdo: boolean;
}

export interface LiveState {
  connection: Connection;
  logic: Logic | null;
  measurements: Measurements;
}

// ── HopeA3 Robot Application (mirrors hopea3::Hopea3State / Hopea3Motor) ──
export interface Hopea3Motor {
  node_id: number;
  online: boolean;
  enabled: boolean;
  target_rev_per_s: number;
  velocity_rev_per_s: number | null;
  torque_nm: number | null;
  max_torque_permille: number;
  driver_temp_c: number | null;
  motor_temp_c: number | null;
  error: string | null;
}

export interface Hopea3InitProgress {
  active: boolean;
  current: number;
  total: number;
  attempt: number;
}

export interface Hopea3State {
  pose_x: number;
  pose_y: number;
  pose_theta: number;
  meas_vx: number;
  meas_vy: number;
  meas_wz: number;
  cmd_vx: number;
  cmd_vy: number;
  cmd_wz: number;
  max_linear: number;
  max_angular: number;
  motors: Hopea3Motor[];
  running: boolean;
}

// Tagged target union the backend deserializes (dto::MotorTargetDto).
export type MotorTarget =
  | { kind: "Disable" }
  | { kind: "Position"; rev: number }
  | { kind: "Velocity"; rev_per_s: number }
  | { kind: "Torque"; nm: number }
  | { kind: "Mit"; pos: number; vel: number; tor: number; kp: number; kd: number };
