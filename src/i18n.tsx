// Minimal in-memory i18n. Default English; a button toggles EN/中. No
// persistence, no auto-detect (per request).

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "zh";

type Entry = { en: string; zh: string };

const STRINGS = {
  // ConnectBar
  bus: { en: "Bus", zh: "总线" },
  ourNid: { en: "Our NID", zh: "本机 NID" },
  connect: { en: "Connect", zh: "连接" },
  disconnect: { en: "Disconnect", zh: "断开" },
  connectedTo: { en: "Connected to", zh: "已连接" },
  connectFailed: { en: "Connect failed", zh: "连接失败" },
  disconnectedMsg: { en: "Disconnected", zh: "已断开" },
  disconnectFailed: { en: "Disconnect failed", zh: "断开失败" },

  // Sidebar
  motors: { en: "Motors", zh: "电机" },
  initAll: { en: "Init all", zh: "全部初始化" },
  discovering: { en: "Discovering…", zh: "等待发现…" },
  notConnected: { en: "Not connected", zh: "未连接" },
  initAllDone: { en: "All initialized", zh: "全部初始化完成" },
  initAllPartial: { en: "Some failed:", zh: "部分失败:" },
  initFailed: { en: "Initialize failed", zh: "初始化失败" },
  languageTip: { en: "切换到中文", zh: "Switch to English" },

  // LivePanel
  online: { en: "Online", zh: "在线" },
  logic: { en: "Logic", zh: "控制逻辑" },
  position: { en: "Position (rev, single-turn)", zh: "位置 (rev, 单圈)" },
  velocity: { en: "Velocity (rev/s, filtered)", zh: "速度 (rev/s, 滤波)" },
  torque: { en: "Torque (Nm)", zh: "力矩 (Nm)" },
  motorTs: { en: "Motor ts (µs)", zh: "电机时间戳 (µs)" },
  statusWord: { en: "Status word", zh: "状态字" },
  modeDisplay: { en: "Mode display (6061)", zh: "模式回显 (6061)" },
  errorReg: { en: "Error register", zh: "错误寄存器" },
  driverTemp: { en: "Driver temp (℃)", zh: "驱动器温度 (℃)" },
  motorTemp: { en: "Motor temp (℃)", zh: "电机温度 (℃)" },

  // Chart series
  chartPos: { en: "Position (rev)", zh: "位置 (rev)" },
  chartVel: { en: "Velocity (rev/s)", zh: "速度 (rev/s)" },
  chartTor: { en: "Torque (Nm)", zh: "力矩 (Nm)" },

  // ControlPanel
  control: { en: "Control", zh: "控制" },
  motorFault: { en: "Motor fault", zh: "电机故障" },
  faultDesc: {
    en: "Clear it before enabling: click Clear Error, then Re-initialize.",
    zh: "使能前需先处理：点「清除错误」后再「重新初始化」。",
  },
  mode: { en: "Mode", zh: "模式" },
  enable: { en: "Enable", zh: "使能" },
  disableAction: { en: "Disable", zh: "失能" },
  clearError: { en: "Clear Error", zh: "清除错误" },
  initialize: { en: "Initialize", zh: "初始化" },
  reinitialize: { en: "Re-initialize", zh: "重新初始化" },
  sendTarget: { en: "Send Target", zh: "发送目标" },
  enableFirst: { en: "Enable the motor first", zh: "请先使能电机" },
  maxTorqueField: {
    en: "Max torque 0x6072 (permille 0–1000)",
    zh: "最大力矩 0x6072 (千分比 0–1000)",
  },
  apply: { en: "Apply", zh: "应用" },
  limitMaxTorque: { en: "Limit max torque", zh: "限制最大力矩" },
  peakUnknown: { en: "(peak torque unknown)", zh: "（峰值力矩未知）" },
  failed: { en: "failed", zh: "失败" },
  posFieldPP: { en: "Position (rev, |x|<0.5)", zh: "位置 (rev, |x|<0.5)" },

  // MotorDetail
  recordCsv: { en: "Record CSV", zh: "记录 CSV" },
  display: { en: "Display", zh: "显示面板" },
  numeric: { en: "Numeric", zh: "数值" },
  chart: { en: "Chart", zh: "图表" },
  window: { en: "Window", zh: "窗口" },
  refresh: { en: "Refresh", zh: "刷新率" },
  refreshHigh: { en: "High", zh: "高" },
  refreshLow: { en: "Low", zh: "低" },
  refreshHint: {
    en: "Display refresh is limited by JS performance. The motor actually reports at up to 1000 Hz over CAN — use CSV logging for the full-rate stream.",
    zh: "界面刷新受 JS 性能限制。电机经 CAN 的实际汇报率可达 1000 Hz，需要全速率数据请用 CSV 记录。",
  },
  peakTorque: { en: "peak torque", zh: "峰值力矩" },
  startedLog: { en: "Recording CSV", zh: "开始记录 CSV" },
  stoppedLog: { en: "Stopped recording", zh: "停止记录" },
  logFailed: { en: "Log action failed", zh: "日志操作失败" },

  // App
  appTitle: { en: "hex-motor host", zh: "hex-motor 上位机" },
  selectMotor: { en: "Select a motor on the left", zh: "在左侧选择一个电机" },
  connectFirst: { en: "Connect to a CAN bus first", zh: "请先连接 CAN 总线" },

  // Modes
  mode_ProfilePosition: { en: "PP Position", zh: "PP 位置" },
  mode_ProfileVelocity: { en: "PV Velocity", zh: "PV 速度" },
  mode_Torque: { en: "Torque", zh: "纯力矩" },
  mode_Mit: { en: "MIT", zh: "MIT" },

  // MIT fields (SI units; converted to the motor's Rev internally)
  mitPos: { en: "pos (rad)", zh: "pos (rad)" },
  mitVel: { en: "vel (rad/s)", zh: "vel (rad/s)" },
  mitTor: { en: "tor (Nm)", zh: "tor (Nm)" },
  mitKp: { en: "kp (Nm/rad)", zh: "kp (Nm/rad)" },
  mitKd: { en: "kd (Nm·s/rad)", zh: "kd (Nm·s/rad)" },

  // Tool selector
  toolControl: { en: "Motor Control", zh: "电机控制" },
  toolChangeId: { en: "Change ID", zh: "改 ID" },
  toolZero: { en: "Set Zero", zh: "零点预设" },
  pickTool: { en: "Pick a tool", zh: "选择工具" },
  toolControlDesc: { en: "Discover, drive, chart & log motors.", zh: "发现、控制、绘图、记录电机。" },
  toolChangeIdDesc: {
    en: "Change a motor's Node-ID. No heartbeat is broadcast, so powering a motor off won't flood the bus.",
    zh: "更改电机 Node-ID。不广播心跳，所以断电不会造成总线错误风暴。",
  },
  toolZeroDesc: {
    en: "Set a motor's current position as its zero (0x3001 preset). RX-only, batch-friendly.",
    zh: "把电机当前位置设为零点（0x3001 预设）。只读总线、适合批量。",
  },
  switchTool: { en: "Switch tool", zh: "切换工具" },

  // Tool categories + Robot Application
  catDirectControl: { en: "Direct Control", zh: "直接控制" },
  catRobotApp: { en: "Robot Application", zh: "机器人应用" },
  toolHopeA3: { en: "HopeA3", zh: "HopeA3" },
  toolHopeA3Desc: {
    en: "Triple-omni mobile base: 3 motors, 500 Hz max-torque PV control over one shared CAN-FD RPDO + live odometry.",
    zh: "三全向轮移动底盘：3 电机，单帧共享 CAN-FD RPDO 的 500 Hz 带最大力矩速度（PV）控制 + 实时里程计。",
  },

  // HopeA3 panel
  hopeStart: { en: "Start", zh: "启动" },
  hopeStop: { en: "Stop", zh: "停止" },
  hopeStarting: { en: "Initializing motors…", zh: "正在初始化电机…" },
  hopeStartFailed: { en: "Start failed", zh: "启动失败" },
  hopeConnectFirst: {
    en: "Connect to the chassis CAN bus, then Start.",
    zh: "先连接底盘 CAN 总线，再点启动。",
  },
  hopeRunning: { en: "Running", zh: "运行中" },
  hopeStopped: { en: "Stopped", zh: "已停止" },
  hopeCmdTwist: { en: "Command velocity", zh: "速度指令" },
  hopeVx: { en: "vx — forward (m/s)", zh: "vx — 前进 (m/s)" },
  hopeVy: { en: "vy — left (m/s)", zh: "vy — 左移 (m/s)" },
  hopeWz: { en: "ωz — yaw CCW (rad/s)", zh: "ωz — 偏航 CCW (rad/s)" },
  hopeStopMotion: { en: "Zero velocity", zh: "速度归零" },
  hopeLimits: { en: "Limits", zh: "限幅" },
  hopeMaxLinear: { en: "Max linear (m/s)", zh: "最大线速度 (m/s)" },
  hopeMaxAngular: { en: "Max angular (rad/s)", zh: "最大角速度 (rad/s)" },
  hopeMaxTorque: { en: "Max torque per motor (‰)", zh: "各电机最大力矩 (‰)" },
  hopeKd: { en: "MIT KD per motor (Nm·s/rad)", zh: "各电机 MIT KD (Nm·s/rad)" },
  hopeMeasTwist: { en: "Measured velocity", zh: "实测速度" },
  hopeOdom: { en: "Odometry (top-down)", zh: "里程计（俯视）" },
  hopeResetOdom: { en: "Reset odometry", zh: "重置里程计" },
  hopePose: { en: "Pose", zh: "位姿" },
  hopeMotorsHdr: { en: "Motors", zh: "电机" },
  hopeTarget: { en: "Target (rev/s)", zh: "目标 (rev/s)" },
  hopeMeasVel: { en: "Actual (rev/s)", zh: "实际 (rev/s)" },
  hopeTrajectory: { en: "Trajectory", zh: "轨迹" },
  hopeHeading: { en: "Heading", zh: "朝向" },
  hopeManual: { en: "Manual drive (keyboard / gamepad)", zh: "手动驾驶（键盘 / 手柄）" },
  hopeKeyboard: { en: "Keyboard (WASD + QE)", zh: "键盘（WASD + QE）" },
  hopeKeyHint: {
    en: "W/S = forward/back, A/D = left/right, Q/E = rotate CCW/CW. Hold to drive; release to stop.",
    zh: "W/S = 前进/后退，A/D = 左移/右移，Q/E = 逆时针/顺时针旋转。按住行驶，松开停止。",
  },
  hopeGamepad: { en: "Gamepad", zh: "手柄" },
  hopeGamepadNone: { en: "not connected", zh: "未连接" },
  hopeManualLinear: { en: "Drive speed (m/s)", zh: "驾驶速度 (m/s)" },
  hopeManualAngular: { en: "Turn speed (rad/s)", zh: "转向速度 (rad/s)" },
  hopeClearErrors: { en: "Clear errors", zh: "清除错误" },
  hopeCleared: { en: "Faults cleared", zh: "已清除错误" },

  toolTutorial: { en: "Tutorial", zh: "使用教程" },
  toolTutorialDesc: {
    en: "New here? A quick swipe-through guide to connecting and driving motors.",
    zh: "第一次用？左右滑动的快速上手指南，带你连接并控制电机。",
  },
  tutorialTitle: { en: "Getting started", zh: "快速上手" },
  tutorialMediaPlaceholder: {
    en: "(screenshot / video goes here)",
    zh: "（此处放截图 / 视频）",
  },

  // Zero / position-preset tool
  zeroTitle: { en: "Position Preset (Zero)", zh: "位置预设（零点）" },
  zeroPick: {
    en: "Pick a motor on the left, or type its ID. The motor must be in Switch On Disabled (fresh power-up).",
    zh: "在左侧选择电机，或填写其 ID。电机需在 Switch On Disabled 状态（刚上电即是）。",
  },
  motorId: { en: "Motor ID", zh: "电机 ID" },
  readPos: { en: "Read position", zh: "读取位置" },
  currentPos: { en: "Current position", zh: "当前位置" },
  presetPos: { en: "Preset position (rev, -0.5..0.5)", zh: "预设位置 (rev, -0.5..0.5)" },
  savePos: { en: "Save as preset", zh: "保存位置" },
  zeroDone: { en: "Preset written", zh: "已写入预设" },
  zeroFailed: { en: "Preset failed", zh: "预设失败" },
  readFailed: { en: "Read failed", zh: "读取失败" },
  discovered: { en: "Discovered", zh: "已发现" },
  never: { en: "—", zh: "—" },

  // Change-ID tool
  changeIdTitle: { en: "Change Node-ID", zh: "更改节点 ID" },
  currentId: { en: "Current ID", zh: "当前 ID" },
  newId: { en: "New ID", zh: "新 ID" },
  changeIdBtn: { en: "Write & Save", zh: "写入并保存" },
  changeIdOk: { en: "Wrote ID change", zh: "已写入 ID 变更" },
  changeIdInstr: {
    en: "After writing, power-cycle the motor; it will re-appear with the new ID below.",
    zh: "写入后给电机重新上电，它会以新 ID 重新出现在下方列表里。",
  },
  changeIdPick: {
    en: "Pick a motor on the left, or type its current ID.",
    zh: "在左侧选择电机，或填写其当前 ID。",
  },
  changeIdFailed: { en: "Change ID failed", zh: "改 ID 失败" },
  sameIdError: { en: "New ID must differ from current", zh: "新 ID 必须与当前不同" },
  forgetOffline: { en: "Forget offline", zh: "清除离线" },
} satisfies Record<string, Entry>;

export type I18nKey = keyof typeof STRINGS;

interface I18nCtx {
  lang: Lang;
  toggle: () => void;
  t: (key: I18nKey) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({
  lang,
  setLang,
  children,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  children: ReactNode;
}) {
  const value = useMemo<I18nCtx>(
    () => ({
      lang,
      toggle: () => setLang(lang === "en" ? "zh" : "en"),
      t: (key) => STRINGS[key][lang],
    }),
    [lang, setLang]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
