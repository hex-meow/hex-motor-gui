//! Arm(Zenoh):连 hex-controller 暴露的机械臂,做发现 / 取控 / 状态 / GRAVITY_COMP /
//! 设重力向量 / 移动到预设位姿。镜像 [`crate::zenoh_base`],但承载关节状态与臂特有 RPC。
//! 持久:一个 Session + 常驻 50Hz 命令流(仅 Active+有目标时发,喂看门狗)+ joint_state/status 订阅。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::anyhow;
use prost::Message;
use serde::Serialize;

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/robot_api.rs"));
}

fn enc<M: Message>(m: &M) -> Vec<u8> {
    let mut b = Vec::new();
    m.encode(&mut b).unwrap();
    b
}

async fn query_one<Resp: Message + Default>(session: &zenoh::Session, key: &str, payload: Vec<u8>) -> Option<Resp> {
    let replies = session.get(key).payload(payload).await.ok()?;
    if let Ok(reply) = replies.recv_async().await {
        if let Ok(sample) = reply.result() {
            return Resp::decode(&*sample.payload().to_bytes()).ok();
        }
    }
    None
}

fn op_mode_name(m: i32) -> &'static str {
    match m {
        1 => "DISABLED",
        2 => "ACTIVE",
        3 => "PASSIVE",
        4 => "GRAVITY_COMP",
        100 => "FAULT",
        101 => "CALIBRATING",
        _ => "UNSPECIFIED",
    }
}

/// 发现到的一个机械臂。
#[derive(Serialize, Clone)]
pub struct ArmInfo {
    pub prefix: String,
    pub model: String,
    pub dof: u32,
    pub has_ee: bool,       // 是否装了末端执行器(目前恒 false,夹爪后续再加)
    pub ee_model: String,
}

/// 推给前端的状态快照。
#[derive(Serialize, Clone, Default)]
pub struct ZenohArmState {
    pub controlling: bool,
    pub holder: u32,
    pub mode: String,        // 我方所设 OperatingMode 名(控制器不回传 OperatingMode)
    pub model: String,
    pub prefix: String,
    pub dof: u32,
    pub joint_names: Vec<String>,
    pub pos_min: Vec<f32>,
    pub pos_max: Vec<f32>,
    pub q: Vec<f32>,
    pub dq: Vec<f32>,
    pub tau: Vec<f32>,
    pub gravity: [f32; 3],   // 我方所设 base 系重力(默认 [0,0,-9.81])
    pub has_ee: bool,
    pub ee_model: String,
}

struct Ctrl {
    prefix: StdMutex<Option<String>>,
    session_id: AtomicU32,
    target: StdMutex<Option<Vec<f32>>>, // Active 时 50Hz 流的目标位姿
    gains: StdMutex<(f32, f32)>,        // (kp, kd) —— host 侧定增益(控制器忠实执行)
    state: StdMutex<ZenohArmState>,
}

pub struct ZenohArmConn {
    session: zenoh::Session,
    ctrl: Arc<Ctrl>,
}

impl ZenohArmConn {
    pub async fn open(connect: &str) -> anyhow::Result<Self> {
        let mut cfg = zenoh::Config::default();
        cfg.insert_json5("mode", "\"peer\"").unwrap();
        if !connect.is_empty() {
            cfg.insert_json5("connect/endpoints", &format!("[\"{connect}\"]")).unwrap();
        }
        let session = zenoh::open(cfg).await.map_err(|e| anyhow!("zenoh open: {e}"))?;
        tokio::time::sleep(Duration::from_millis(700)).await;
        let mut s0 = ZenohArmState::default();
        s0.gravity = [0.0, 0.0, -9.81];
        let ctrl = Arc::new(Ctrl {
            prefix: StdMutex::new(None),
            session_id: AtomicU32::new(0),
            target: StdMutex::new(None),
            gains: StdMutex::new((20.0, 1.5)),
            state: StdMutex::new(s0),
        });

        // 50Hz 命令流:仅在持有会话且设了目标(Active 移动)时发 JointTrajectory(喂看门狗 + 命令目标)。
        // GRAVITY_COMP/PASSIVE 不设目标 → 不发(看门狗在控制器侧只对 ACTIVE 生效)。
        {
            let s = session.clone();
            let c = ctrl.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(20));
                loop {
                    tick.tick().await;
                    let sid = c.session_id.load(Ordering::Relaxed);
                    if sid == 0 { continue; }
                    let Some(prefix) = c.prefix.lock().unwrap().clone() else { continue };
                    let Some(target) = c.target.lock().unwrap().clone() else { continue };
                    let (kp, kd) = *c.gains.lock().unwrap();
                    let n = target.len();
                    let jt = pb::JointTrajectory {
                        header: None,
                        session_id: sid,
                        points: vec![pb::JointSetpoint { q: target, dq: vec![], kp: vec![kp; n], kd: vec![kd; n], tau_ff: vec![] }],
                        t_from_start_ns: vec![0],
                        on_timeout: pb::TimeoutBehavior::Hold as i32,
                    };
                    let _ = s.put(format!("{prefix}/arm/command"), enc(&jt)).await;
                }
            });
        }
        // joint_state 订阅(通配,按 prefix 过滤)。
        if let Ok(sub) = session.declare_subscriber("hexmeow/**/arm/joint_state").await {
            let c = ctrl.clone();
            tokio::spawn(async move {
                while let Ok(sample) = sub.recv_async().await {
                    let Some(p) = c.prefix.lock().unwrap().clone() else { continue };
                    if !sample.key_expr().as_str().starts_with(&p) { continue; }
                    if let Ok(js) = pb::JointState::decode(&*sample.payload().to_bytes()) {
                        let mut st = c.state.lock().unwrap();
                        st.q = js.q; st.dq = js.dq; st.tau = js.tau_est;
                    }
                }
            });
        }
        // status 订阅 → holder。
        if let Ok(sub) = session.declare_subscriber("hexmeow/**/status").await {
            let c = ctrl.clone();
            tokio::spawn(async move {
                while let Ok(sample) = sub.recv_async().await {
                    let Some(p) = c.prefix.lock().unwrap().clone() else { continue };
                    if !sample.key_expr().as_str().starts_with(&p) { continue; }
                    if let Ok(s) = pb::RobotStatus::decode(&*sample.payload().to_bytes()) {
                        c.state.lock().unwrap().holder = s.session_holder;
                    }
                }
            });
        }

        Ok(Self { session, ctrl })
    }

    pub async fn discover(&self) -> Vec<ArmInfo> {
        let mut out = Vec::new();
        if let Ok(replies) = self.session.get("hexmeow/**/description").await {
            while let Ok(reply) = replies.recv_async().await {
                if let Ok(sample) = reply.result() {
                    if let Ok(d) = pb::RobotDescription::decode(&*sample.payload().to_bytes()) {
                        if d.kind == pb::RobotKind::Arm as i32 {
                            let key = sample.key_expr().as_str();
                            let prefix = key.strip_suffix("/description").unwrap_or(key).to_string();
                            // EE:device_keys 里有 /ee 即视为装了 EE(目前没夹爪 → 多半 false)。
                            let has_ee = d.device_keys.iter().any(|k| k.ends_with("/ee"));
                            let dof = query_one::<pb::ArmDescription>(&self.session, &format!("{prefix}/arm/description"), vec![])
                                .await.map(|a| a.dof).unwrap_or(0);
                            out.push(ArmInfo { prefix, model: d.model, dof, has_ee, ee_model: String::new() });
                        }
                    }
                }
            }
        }
        out
    }

    pub async fn acquire(&self, prefix: &str, model: &str) -> anyhow::Result<()> {
        let req = pb::AcquireSessionRequest { client_name: Some("hex-motor-gui".into()), liveliness_key: None };
        let resp: pb::AcquireSessionResponse = query_one(&self.session, &format!("{prefix}/rpc/acquire_session"), enc(&req))
            .await.ok_or_else(|| anyhow!("acquire 无回复"))?;
        if !resp.ok {
            return Err(anyhow!("被占用:holder {} {:?}", resp.current_holder, resp.current_holder_name));
        }
        self.ctrl.session_id.store(resp.session_id, Ordering::Relaxed);
        *self.ctrl.prefix.lock().unwrap() = Some(prefix.to_string());
        // 取 arm/description 填关节名/限位
        let desc = query_one::<pb::ArmDescription>(&self.session, &format!("{prefix}/arm/description"), vec![]).await;
        let mut st = self.ctrl.state.lock().unwrap();
        st.controlling = true; st.prefix = prefix.into(); st.model = model.into(); st.mode = "DISABLED".into();
        if let Some(d) = desc {
            st.dof = d.dof; st.joint_names = d.joint_names; st.pos_min = d.pos_min; st.pos_max = d.pos_max;
        }
        Ok(())
    }

    /// 设 OperatingMode(2=ACTIVE,3=PASSIVE,4=GRAVITY_COMP,1=DISABLED)。非 Active 清目标。
    pub async fn set_mode(&self, mode: i32) -> anyhow::Result<()> {
        let sid = self.ctrl.session_id.load(Ordering::Relaxed);
        if sid == 0 { return Err(anyhow!("未持有控制权")); }
        if mode != 2 { *self.ctrl.target.lock().unwrap() = None; } // 非 Active:停命令流
        let req = pb::SetModeRequest { session_id: sid, mode };
        let _: Option<pb::GenericResponse> = query_one(&self.session, &format!("{}/rpc/set_mode", self.prefix()), enc(&req)).await;
        self.ctrl.state.lock().unwrap().mode = op_mode_name(mode).into();
        Ok(())
    }

    /// 移动到预设位姿(进 ACTIVE + 50Hz 流目标)。kp/kd 由 host(GUI)给,控制器忠实执行。
    pub async fn goto(&self, q: Vec<f32>, kp: f32, kd: f32) -> anyhow::Result<()> {
        let sid = self.ctrl.session_id.load(Ordering::Relaxed);
        if sid == 0 { return Err(anyhow!("未持有控制权")); }
        *self.ctrl.gains.lock().unwrap() = (kp, kd);
        *self.ctrl.target.lock().unwrap() = Some(q);
        let req = pb::SetModeRequest { session_id: sid, mode: 2 };
        let _: Option<pb::GenericResponse> = query_one(&self.session, &format!("{}/rpc/set_mode", self.prefix()), enc(&req)).await;
        self.ctrl.state.lock().unwrap().mode = "ACTIVE".into();
        Ok(())
    }

    pub async fn set_gravity(&self, g: [f32; 3]) -> anyhow::Result<()> {
        let sid = self.ctrl.session_id.load(Ordering::Relaxed);
        if sid == 0 { return Err(anyhow!("未持有控制权")); }
        let req = pb::SetGravityRequest { session_id: sid, gravity: Some(pb::Vec3 { x: g[0], y: g[1], z: g[2] }) };
        let _: Option<pb::GenericResponse> = query_one(&self.session, &format!("{}/rpc/set_gravity", self.prefix()), enc(&req)).await;
        self.ctrl.state.lock().unwrap().gravity = g;
        Ok(())
    }

    pub fn state(&self) -> ZenohArmState {
        self.ctrl.state.lock().unwrap().clone()
    }

    pub async fn release(&self) {
        let sid = self.ctrl.session_id.swap(0, Ordering::Relaxed);
        *self.ctrl.target.lock().unwrap() = None;
        let prefix = self.ctrl.prefix.lock().unwrap().clone();
        if let (Some(prefix), true) = (prefix, sid != 0) {
            let req = pb::ReleaseSessionRequest { session_id: sid };
            let _: Option<pb::GenericResponse> = query_one(&self.session, &format!("{prefix}/rpc/release_session"), enc(&req)).await;
        }
        *self.ctrl.prefix.lock().unwrap() = None;
        let mut st = self.ctrl.state.lock().unwrap();
        st.controlling = false; st.holder = 0; st.mode = "DISABLED".into();
    }

    fn prefix(&self) -> String {
        self.ctrl.prefix.lock().unwrap().clone().unwrap_or_default()
    }
}
