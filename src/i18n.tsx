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

  // IMU panel
  imuTitle: { en: "IMU", zh: "IMU" },
  imuStreaming: { en: "Streaming", zh: "数据流" },
  imuStarting: { en: "Starting…", zh: "启动中…" },
  imuOffline: { en: "No data", zh: "无数据" },
  imuOrientation: { en: "Orientation", zh: "姿态" },
  imuRoll: { en: "Roll", zh: "横滚 Roll" },
  imuPitch: { en: "Pitch", zh: "俯仰 Pitch" },
  imuYaw: { en: "Yaw", zh: "航向 Yaw" },
  imuQuaternion: { en: "Quaternion (w,x,y,z)", zh: "四元数 (w,x,y,z)" },
  imuAccel: { en: "Acceleration (g)", zh: "加速度 (g)" },
  imuGyro: { en: "Angular rate (°/s)", zh: "角速度 (°/s)" },
  imuTemp: { en: "Temperature (°C)", zh: "温度 (°C)" },
  imuSamples: { en: "Samples", zh: "采样计数" },
  imuBiasTrim: { en: "Gyro bias trim", zh: "陀螺零偏标定" },
  imuBiasTrimHint: { en: "Hold the device still, then trim to reduce yaw drift.", zh: "保持设备静止后标定，可降低 yaw 漂移。" },
  imuYawReset: { en: "Reset yaw", zh: "航向归零" },
  imuCmdSent: { en: "Command sent", zh: "命令已发送" },
  imuCmdFailed: { en: "Command failed", zh: "命令失败" },
  imuStartFailed: { en: "Start failed", zh: "启动失败" },

  // CAN Analyzer
  toolCanalyzer: { en: "CAN Analyzer", zh: "CAN 分析仪" },
  toolCanalyzerDesc: { en: "Sniff bus traffic, filter/decode CANopen, send frames manually.", zh: "抓取总线报文、过滤/解析 CANopen、手动发帧。" },
  canBus: { en: "Bus", zh: "总线" },
  canConnectHint: { en: "e.g. can0 / socketcan:vcan0 / gs_usb", zh: "例如 can0 / socketcan:vcan0 / gs_usb" },
  canConnectFailed: { en: "Capture failed", zh: "抓包失败" },
  canModeTrace: { en: "Trace", zh: "逐帧" },
  canModeGrouped: { en: "Grouped by ID", zh: "按 ID 汇总" },
  canInterpret: { en: "CANopen decode", zh: "CANopen 解析" },
  canRefreshHint: {
    en: "Frontend drain and render refresh. Higher rates look smoother but cost more CPU.",
    zh: "前端 drain 与渲染刷新率。高档更顺滑，但会占用更多 CPU。",
  },
  canFilterAll: { en: "No filter", zh: "不过滤" },
  canFilterNode: { en: "By node", zh: "按节点" },
  canFilterMask: { en: "By id+mask", zh: "按 id+掩码" },
  canNode: { en: "Node", zh: "节点" },
  canIncludeNodeless: { en: "+ NMT/SYNC/…", zh: "+ NMT/SYNC/…" },
  canId: { en: "id", zh: "id" },
  canMask: { en: "mask", zh: "掩码" },
  canExt: { en: "Ext (29-bit)", zh: "扩展帧 (29 位)" },
  canPause: { en: "Freeze", zh: "冻结" },
  canResume: { en: "Resume", zh: "继续" },
  canFrozen: { en: "Frozen", zh: "已冻结" },
  canLive: { en: "Live", zh: "实时" },
  canClear: { en: "Clear", zh: "清空" },
  canGap: { en: "Trace gap — some frames rolled off before display (bus faster than the view).", zh: "存在丢帧缺口——部分帧在显示前已滚出缓冲（总线速率超过视图）。" },
  canAggOverflow: { en: "Too many distinct IDs — some are no longer tracked in the grouped view.", zh: "不同 ID 过多——部分 ID 已不再计入汇总视图。" },
  canNotCapturing: { en: "Not capturing. Enter a bus and press Connect.", zh: "未抓包。请填写总线并点击连接。" },
  canActive: { en: "Active", zh: "活跃" },
  canIdle: { en: "Idle", zh: "空闲" },
  canStopped: { en: "Stopped", zh: "已停止" },
  canRxRate: { en: "RX rate", zh: "接收速率" },
  canTotal: { en: "Frames", zh: "总帧数" },
  canDistinct: { en: "IDs", zh: "ID 数" },
  canGuiDrops: { en: "GUI drops", zh: "GUI 丢帧" },
  canGuiDropsHint: { en: "Frames our subscriber queue overflowed (host/GUI too slow). NOT a bus error.", zh: "本机订阅队列溢出丢弃的帧（主机/GUI 处理不过来），并非总线错误。" },
  canErrCounters: { en: "Bus errors", zh: "总线错误" },
  canErrHint: { en: "Controller TX/RX error counters (TEC/REC). “—” = this backend/firmware doesn't report them.", zh: "控制器 TX/RX 错误计数（TEC/REC）。“—”表示该后端/固件不上报。" },
  canHwTs: { en: "HW timestamp", zh: "硬件时间戳" },
  canHwTsHint: { en: "Stamp frames with the adapter's hardware clock (gs_usb only, needs firmware support). Falls back to host time if unsupported.", zh: "用适配器硬件时钟为帧打时间戳（仅 gs_usb，需固件支持）。不支持时自动回退主机时间。" },
  canHwTsActiveHint: { en: "Trace times come from the device's hardware clock.", zh: "trace 时间来自设备硬件时钟。" },
  canCtrlStateHint: { en: "CAN controller fault-confinement state, polled from the adapter.", zh: "CAN 控制器错误约束状态（从适配器轮询）。" },
  canStateErrorActive: { en: "Error-active", zh: "正常 (error-active)" },
  canStateErrorWarning: { en: "Error-warning", zh: "警告 (warning)" },
  canStateErrorPassive: { en: "Error-passive", zh: "被动错误 (passive)" },
  canStateBusOff: { en: "BUS-OFF", zh: "BUS-OFF 离线" },
  canStateStopped: { en: "Stopped", zh: "已停止" },
  canStateSleeping: { en: "Sleeping", zh: "休眠" },
  canColSeq: { en: "#", zh: "#" },
  canColTime: { en: "t (ms)", zh: "t (ms)" },
  canColDir: { en: "dir", zh: "方向" },
  canDirHint: {
    en: "TX = frames sent by this tool (manual send / SDO tab) — accepted by the driver, not necessarily ACKed on the bus. Everything else is RX; on SocketCAN that includes frames sent by other programs on this machine.",
    zh: "TX = 本工具发出的帧（手动发帧 / SDO）——表示驱动已接受，不代表总线上已被 ACK。其余一律为 RX；SocketCAN 下本机其他程序发的帧也会以 RX 出现。",
  },
  canColId: { en: "ID", zh: "ID" },
  canColKind: { en: "decode", zh: "解析" },
  canColDlc: { en: "dlc", zh: "dlc" },
  canColData: { en: "data", zh: "数据" },
  canColCount: { en: "Count", zh: "计数" },
  canColRate: { en: "Rate", zh: "速率" },
  canTabSend: { en: "Send frame", zh: "发送帧" },
  canSdoIndex: { en: "Index", zh: "索引" },
  canSdoSub: { en: "Sub", zh: "子索引" },
  canSdoTypeRaw: { en: "(raw)", zh: "(原始)" },
  canSdoValue: { en: "value (for write)", zh: "值（写入用）" },
  canSdoRead: { en: "Read", zh: "读" },
  canSdoWrite: { en: "Write", zh: "写" },
  canSdoNeedType: { en: "Writing needs a datatype (not raw)", zh: "写入需要选择数据类型（非原始）" },
  canSdoRadixHint: { en: "0x… = hex, bare digits = decimal (same as comeow)", zh: "0x… 为十六进制，纯数字为十进制（与 comeow 一致）" },
  canSdoRetries: { en: "retry", zh: "重试" },
  canSdoLogEmpty: { en: "SDO results appear here. Same engine & datatypes as comeow (u16 / x32 / vs / hex …).", zh: "SDO 结果显示在这里。与 comeow 同引擎、同数据类型（u16 / x32 / vs / hex …）。" },
  canSendBtn: { en: "Send", zh: "发送" },
  canSendFailed: { en: "Send failed", zh: "发送失败" },
  canDataHint: { en: "hex bytes, e.g. 11 22 33", zh: "十六进制字节，例如 11 22 33" },
  canMaxBytes: { en: "max bytes", zh: "最大字节数" },
  canRtrDlc: { en: "RTR DLC", zh: "RTR 请求长度" },
  canRepeat: { en: "Repeat", zh: "循环发送" },
  canStop: { en: "Stop", zh: "停止" },

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
  toolPickerEyebrow: { en: "Tool launcher", zh: "工具启动器" },
  toolPickerTitle: { en: "Pick a workspace", zh: "选择工作区" },
  toolPickerLead: {
    en: "Choose a motor-control workflow, a robot application, or a utility for setup and diagnostics.",
    zh: "选择电机控制工作流、机器人应用，或用于配置与诊断的工具。",
  },
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
  catMotorControl: { en: "Motor Control", zh: "电机控制" },
  catMotorControlHint: { en: "Single-motor workflows", zh: "单电机工作流" },
  catTools: { en: "Tools", zh: "工具" },
  catToolsHint: { en: "Setup, calibration and bus inspection", zh: "配置、标定与总线检查" },
  catDirectControl: { en: "Direct Control", zh: "直接控制" },
  catRobotApp: { en: "Robot Application", zh: "机器人应用" },
  catRobotAppHint: { en: "Base, arm and integrated demos", zh: "底盘、机械臂与综合演示" },
  tagLiveControl: { en: "Live control", zh: "实时控制" },
  tagHaptics: { en: "Haptics", zh: "力反馈" },
  tagRobotApi: { en: "Robot API", zh: "Robot API" },
  tagManipulator: { en: "Manipulator", zh: "机械臂" },
  tagMobileBase: { en: "Mobile base", zh: "移动底盘" },
  tagFactorySetup: { en: "Factory setup", zh: "工厂配置" },
  tagCalibration: { en: "Calibration", zh: "标定" },
  tagDebug: { en: "Debug", zh: "调试" },
  tagQuickStart: { en: "Quick start", zh: "快速上手" },
  toolHopeA3: { en: "HopeA3(Raw Motor)", zh: "HopeA3(原始电机)" },
  toolHopeA3Desc: {
    en: "Triple-omni mobile base: 3 motors, 500 Hz max-torque PV control over one shared CAN-FD RPDO + live odometry.",
    zh: "三全向轮移动底盘：3 电机，单帧共享 CAN-FD RPDO 的 500 Hz 带最大力矩速度（PV）控制 + 实时里程计。",
  },
  toolSmartKnob: { en: "SmartKnob", zh: "智能旋钮" },
  toolSmartKnobDesc: {
    en: "Turn a single 4310/4342 into a haptic knob: software detents, endstops & return-to-center via high-rate MIT torque streaming. No press sensor — switch modes with the on-screen button.",
    zh: "把单个 4310/4342 变成力反馈旋钮：高频 MIT 力矩流实现软件卡位、限位与回中。无下压传感器——用界面按钮切换模式。",
  },
  toolBaseZenoh: { en: "Base(Zenoh)", zh: "Base(Zenoh)" },
  toolBaseZenohDesc: {
    en: "Connect to a hex-controller over Zenoh: auto-discover bases, take control, and drive — the productized robot_api path.",
    zh: "通过 Zenoh 连接 hex-controller：自动发现底盘、取得控制权、移动——产品化的 robot_api 路径。",
  },
  toolArmZenoh: { en: "Arm (Zenoh)", zh: "Arm (Zenoh)" },
  toolArmZenohDesc: {
    en: "Digital twin, gravity compensation, gravity setup and preset postures.",
    zh: "机械臂数字孪生、重力补偿、设置重力与预设位姿。",
  },
  // Base(Zenoh) panel
  zEndpoint: { en: "Endpoint (optional)", zh: "地址(可选)" },
  zEndpointHint: { en: "blank = auto-scan LAN (multicast)", zh: "留空 = 自动扫描局域网(组播)" },
  zConnect: { en: "Connect", zh: "连接" },
  zDisconnect: { en: "Disconnect", zh: "断开" },
  zConnected: { en: "Connected", zh: "已连接" },
  zDisconnected: { en: "Disconnected", zh: "未连接" },
  zDiscover: { en: "Discover bases", zh: "发现底盘" },
  zNoBase: { en: "No base found (is the controller running?)", zh: "未发现底盘（控制器起了吗？）" },
  zFound: { en: "Found", zh: "已发现" },
  zAcquire: { en: "Take control", zh: "取得控制权" },
  zRelease: { en: "Release", zh: "释放控制权" },
  zControlling: { en: "You are in control", zh: "你正在控制" },
  zNotControlling: { en: "View-only (no control)", zh: "仅查看（未取得控制）" },
  zBusy: { en: "Controlled by another client", zh: "被其他客户端控制" },
  zActive: { en: "Active (motors armed)", zh: "已激活（电机使能）" },
  zActiveShort: { en: "Armed", zh: "使能" },
  zHolder: { en: "Holder", zh: "控制方" },
  zMove: { en: "Drive (hold to move, release to stop)", zh: "驾驶（按住移动，松开停止）" },
  zDriveTitle: { en: "Drive", zh: "驾驶" },
  zDriveHint: { en: "Pointer controls send velocity while held.", zh: "按住按钮发送速度，松开即停止。" },
  zSpeedLin: { en: "Linear speed (m/s)", zh: "线速度 (m/s)" },
  zSpeedAng: { en: "Angular speed (rad/s)", zh: "角速度 (rad/s)" },
  zKeyboard: { en: "Keyboard", zh: "键盘" },
  zKeyHint: {
    en: "W/S forward/back, A/D strafe, Q/E rotate.",
    zh: "W/S 前进后退，A/D 左右平移，Q/E 旋转。",
  },
  zPose: { en: "Pose (odometry)", zh: "位姿（里程计）" },
  zPose3d: { en: "3D odometry", zh: "3D 里程计" },
  zLiveOdom: { en: "Live odom", zh: "实时里程计" },
  zNoOdom: { en: "No odom", zh: "无里程计" },
  zTwist: { en: "Measured twist", zh: "实测速度" },
  zTelemetry: { en: "Telemetry", zh: "遥测" },
  zStop: { en: "STOP", zh: "急停归零" },

  // SmartKnob panel
  skConnectFirst: { en: "Connect to the bus first.", zh: "请先连接总线。" },
  skNoMotors: { en: "No motors discovered yet…", zh: "尚未发现电机…" },
  skMotor: { en: "Knob motor", zh: "旋钮电机" },
  skStart: { en: "Start knob", zh: "启动旋钮" },
  skStarting: { en: "Initializing…", zh: "正在初始化…" },
  skStop: { en: "Stop", zh: "停止" },
  skStartFailed: { en: "Start failed", zh: "启动失败" },
  skRunning: { en: "Running", zh: "运行中" },
  skStopped: { en: "Stopped", zh: "已停止" },
  skClearError: { en: "Clear error", zh: "清除错误" },
  skCleared: { en: "Cleared", zh: "已清除" },
  skModes: { en: "Modes (mode button = press substitute)", zh: "模式（模式按钮 = 代替下压）" },
  skValue: { en: "Value", zh: "数值" },
  skPosition: { en: "Position", zh: "位置" },
  skUnbounded: { en: "Unbounded", zh: "无限旋转" },
  skEndstop: { en: "Endstop", zh: "限位" },
  skAngle: { en: "Shaft angle", zh: "轴角度" },
  skTorque: { en: "Torque (Nm)", zh: "力矩 (Nm)" },
  skTuning: { en: "Tuning", zh: "调参" },
  skStrength: { en: "Strength scale (Nm/unit)", zh: "强度系数 (Nm/单位)" },
  skTorqueLimit: { en: "Torque limit (Nm)", zh: "力矩上限 (Nm)" },
  skMaxTorque: { en: "Motor max torque (‰)", zh: "电机最大力矩 (‰)" },
  skFrictionComp: { en: "Friction comp (Nm)", zh: "摩擦补偿 (Nm)" },
  skClickTorque: { en: "Click torque (Nm)", zh: "弹片强度 (Nm)" },
  skPGain: { en: "P-gain", zh: "P 增益" },
  skDGain: { en: "D-gain", zh: "D 增益" },
  skRecommendedGains: { en: "Use recommended P/D", zh: "使用推荐 P/D" },
  skTuningFeel: { en: "Tuning — Feel", zh: "调参 — 手感" },
  skTuningSafety: { en: "Tuning — Safety", zh: "调参 — 安全" },
  skModeConfig: { en: "Mode config", zh: "模式配置" },
  skCustomConfig: { en: "Custom mode config", zh: "自定义模式配置" },
  skCustomLocked: { en: "Config locked for preset modes", zh: "预设模式配置已锁定" },
  skCustomName: { en: "Mode name", zh: "模式名称" },
  skLedHue: { en: "LED hue (0-255)", zh: "LED 色相 (0-255)" },
  skMinPos: { en: "Min position", zh: "最小位置" },
  skMaxPos: { en: "Max position", zh: "最大位置" },
  skPosWidth: { en: "Position width (°)", zh: "位置宽度 (度)" },
  skDetentStrength: { en: "Detent strength", zh: "卡位强度" },
  skEndstopStrength: { en: "Endstop strength", zh: "限位强度" },
  skSnapPoint: { en: "Snap point", zh: "吸附点" },


  // HopeA3 panel
  hopeStart: { en: "Start", zh: "启动" },
  hopeStop: { en: "Stop", zh: "停止" },
  hopeStarting: { en: "Initializing motors…", zh: "正在初始化电机…" },
  hopeStartFailed: { en: "Start failed", zh: "启动失败" },
  hopeConnectFirst: {
    en: "Connect to the chassis CAN bus, then Start.",
    zh: "先连接底盘 CAN 总线，再点启动。",
  },
  hopeNeedConnect: { en: "Connect to the chassis CAN bus before starting.", zh: "请先连接底盘 CAN 总线，然后才能启动。" },
  hopeStartHint: { en: "Initialize motors, arm the controller, then unlock drive controls.", zh: "初始化电机并进入运行状态后，驾驶控制才会解锁。" },
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
  hopeAccLinear: { en: "Max accel (m/s², 0=off)", zh: "最大加速度 (m/s², 0=关)" },
  hopeAccAngular: { en: "Max ang. accel (rad/s², 0=off)", zh: "最大角加速度 (rad/s², 0=关)" },
  hopeMaxTorque: { en: "Max torque per motor (‰)", zh: "各电机最大力矩 (‰)" },
  hopeKd: { en: "MIT KD per motor (Nm·s/rad)", zh: "各电机 MIT KD (Nm·s/rad)" },
  hopeMeasTwist: { en: "Measured velocity", zh: "实测速度" },
  hopeOdom: { en: "3D odometry", zh: "3D 里程计" },
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
