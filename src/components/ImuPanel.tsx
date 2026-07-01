// IMU device panel (2D + 3D).
//
// Mounts when an IMU is selected in the device list. It starts the stream
// (NMT-Start + TPDO1 subscribe) on mount and stops it on unmount, polls the
// snapshot, and shows: a 3D orientation view, Euler/quaternion/temperature
// readouts, live accel + gyro charts, and the bias-trim / yaw-reset commands.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { App as AntdApp, Button, Card, Col, Row, Space, Statistic, Tag, Tooltip, Typography } from "antd";
import ReactECharts from "echarts-for-react";
import { api, errMsg } from "../api";
import { useI18n } from "../i18n";
import { nid2hex } from "../format";
import { useImuTelemetry, type ImuSample } from "../useImuTelemetry";
import { ImuViewer } from "./ImuViewer";
import type { MotorInfo } from "../types";

const RAD2DEG = 180 / Math.PI;

/** Quaternion [w,x,y,z] → roll/pitch/yaw in degrees (aerospace ZYX). */
function quatToEuler([w, x, y, z]: [number, number, number, number]) {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  let sp = 2 * (w * y - z * x);
  sp = Math.max(-1, Math.min(1, sp));
  const pitch = Math.asin(sp);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { roll: roll * RAD2DEG, pitch: pitch * RAD2DEG, yaw: yaw * RAD2DEG };
}

const AXIS_COLORS = ["#ff6b6b", "#2ecc71", "#4f8cff"]; // x, y, z

function ImuChart({
  samples,
  chartVersion,
  pick,
  unit,
}: {
  samples: MutableRefObject<ImuSample[]>;
  chartVersion: number;
  pick: (s: ImuSample) => [number, number, number];
  unit: string;
}) {
  const option = useMemo(() => {
    const buf = samples.current;
    const now = performance.now();
    const names = ["X", "Y", "Z"];
    const series = names.map((nm, i) => ({
      name: nm,
      type: "line",
      showSymbol: false,
      lineStyle: { width: 1.5, color: AXIS_COLORS[i] },
      itemStyle: { color: AXIS_COLORS[i] },
      data: buf.map((s) => [(s.t - now) / 1000, pick(s)[i]]),
    }));
    return {
      animation: false,
      grid: { left: 48, right: 12, top: 24, bottom: 28 },
      legend: { data: names, textStyle: { color: "#aaa" }, top: 0, right: 0 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "value",
        min: -20,
        max: 0,
        axisLabel: { color: "#888", formatter: (v: number) => `${v}s` },
        splitLine: { lineStyle: { color: "#2a2a2a" } },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: unit,
        nameTextStyle: { color: "#888" },
        axisLabel: { color: "#888" },
        splitLine: { lineStyle: { color: "#2a2a2a" } },
      },
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartVersion, unit]);

  return <ReactECharts option={option} notMerge style={{ height: 200 }} />;
}

export function ImuPanel({ info, connected }: { info: MotorInfo; connected: boolean }) {
  const { t } = useI18n();
  const { message } = AntdApp.useApp();
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const busyRef = useRef(false);

  // Start the stream on mount (per-device key remounts this component), stop
  // it on unmount.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    setStarting(true);
    api
      .imuStart(info.node_id)
      .then(() => {
        if (alive) setRunning(true);
      })
      .catch((e) => {
        if (alive) message.error(`${t("imuStartFailed")}: ${errMsg(e)}`);
      })
      .finally(() => {
        if (alive) setStarting(false);
      });
    return () => {
      alive = false;
      setRunning(false);
      api.imuStop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.node_id, connected]);

  const { latest, samples, chartVersion } = useImuTelemetry(running);

  const cmd = useCallback(
    async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await fn();
        message.success(t("imuCmdSent"));
      } catch (e) {
        message.error(`${t("imuCmdFailed")}: ${errMsg(e)}`);
      } finally {
        busyRef.current = false;
      }
    },
    [message, t]
  );

  const q = latest?.quaternion ?? ([1, 0, 0, 0] as [number, number, number, number]);
  const euler = quatToEuler(q);
  const online = !!latest?.online;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }}>
        <Space>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {info.friendly_name || t("imuTitle")}
          </Typography.Title>
          <Typography.Text code>{nid2hex(info.node_id)}</Typography.Text>
          {starting ? (
            <Tag color="processing">{t("imuStarting")}</Tag>
          ) : online ? (
            <Tag color="success">{t("imuStreaming")}</Tag>
          ) : (
            <Tag color="warning">{t("imuOffline")}</Tag>
          )}
        </Space>
        <Space>
          <Tooltip title={t("imuBiasTrimHint")}>
            <Button onClick={() => cmd(api.imuBiasTrim)} disabled={!running}>
              {t("imuBiasTrim")}
            </Button>
          </Tooltip>
          <Button onClick={() => cmd(api.imuYawReset)} disabled={!running}>
            {t("imuYawReset")}
          </Button>
        </Space>
      </Space>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title={t("imuOrientation")} size="small">
            <ImuViewer quaternion={q} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small">
            <Row gutter={[16, 16]}>
              <Col span={8}>
                <Statistic title={t("imuRoll")} value={euler.roll} precision={1} suffix="°" />
              </Col>
              <Col span={8}>
                <Statistic title={t("imuPitch")} value={euler.pitch} precision={1} suffix="°" />
              </Col>
              <Col span={8}>
                <Statistic title={t("imuYaw")} value={euler.yaw} precision={1} suffix="°" />
              </Col>
              <Col span={24}>
                <Typography.Text type="secondary">{t("imuQuaternion")}</Typography.Text>
                <div style={{ fontFamily: "monospace", marginTop: 4 }}>
                  [{q.map((v) => v.toFixed(3)).join(", ")}]
                </div>
              </Col>
              <Col span={12}>
                <Statistic title={t("imuTemp")} value={latest?.temp_c ?? 0} precision={1} suffix="°C" />
              </Col>
              <Col span={12}>
                <Statistic title={t("imuSamples")} value={latest?.counter ?? 0} />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title={t("imuAccel")} size="small">
            <ImuChart
              samples={samples}
              chartVersion={chartVersion}
              pick={(s) => [s.ax, s.ay, s.az]}
              unit="g"
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t("imuGyro")} size="small">
            <ImuChart
              samples={samples}
              chartVersion={chartVersion}
              pick={(s) => [s.gx, s.gy, s.gz]}
              unit="°/s"
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
