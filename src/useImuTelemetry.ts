// Polling hook for the IMU snapshot (mirrors useTelemetry's shape).
// Polls `imu_get_state` while `running`, keeps a rolling buffer of accel/gyro
// samples for the live charts, and bumps `chartVersion` on a slower cadence so
// charts re-render decoupled from the fast poll.

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ImuState } from "./types";

export interface ImuSample {
  t: number; // performance.now() ms
  ax: number; ay: number; az: number; // g
  gx: number; gy: number; gz: number; // deg/s
}

const BUFFER_MS = 30_000;
const CHART_MS = 200;

export function useImuTelemetry(running: boolean, rateHz = 50) {
  const intervalMs = Math.max(1, Math.round(1000 / rateHz));
  const [latest, setLatest] = useState<ImuState | null>(null);
  const bufRef = useRef<ImuSample[]>([]);
  const [chartVersion, setChartVersion] = useState(0);

  useEffect(() => {
    if (!running) {
      setLatest(null);
      bufRef.current = [];
      return;
    }
    let alive = true;
    const poll = window.setInterval(async () => {
      try {
        const s = await api.imuGetState();
        if (!alive) return;
        setLatest(s);
        const now = performance.now();
        const buf = bufRef.current;
        buf.push({
          t: now,
          ax: s.accel[0], ay: s.accel[1], az: s.accel[2],
          gx: s.gyro[0], gy: s.gyro[1], gz: s.gyro[2],
        });
        const cutoff = now - BUFFER_MS;
        while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
      } catch {
        /* transient (e.g. just stopped) — ignore */
      }
    }, intervalMs);
    const chartTick = window.setInterval(() => {
      if (alive) setChartVersion((v) => v + 1);
    }, CHART_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(chartTick);
    };
  }, [running, intervalMs]);

  return { latest, samples: bufRef, chartVersion };
}
