// Polling hook for the CAN analyzer (mirrors useImuTelemetry's decoupling).
//
// A fast POLL timer drains bounded batches from the backend into refs; a slower
// RENDER timer bumps a version counter to trigger a re-render. Nothing renders
// per frame. Trace mode uses a seq cursor (so each poll only pulls *new* frames);
// grouped mode pulls the whole small per-ID table. Freeze pauses rendering but
// keeps draining so drop/gap accounting stays honest.

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CanAggRow, CanAnalyzerStatus, CanBusHealth, CanFilterSpec, CanTraceFrame } from "./types";

const POLL_MS = 50; // 20 Hz backend drain
const RENDER_MS = 100; // 10 Hz UI tick
const HEALTH_MS = 1000; // 1 Hz controller-health poll (netlink / USB control)
const MAX_ROWS = 3000; // client trace buffer cap
const MAX_BATCH = 2000; // frames requested per poll
const RATE_WINDOW_MS = 1500; // rolling window for the fps estimate (smooths sparse traffic)
/** Bus is "active" if a frame arrived within this window. Must exceed the
 *  slowest expected heartbeat (CANopen nodes heartbeat every ~0.5–1 s) so a
 *  single node doesn't flicker idle/active between beats. */
export const ACTIVE_WINDOW_MS = 2500;

export type CanMode = "trace" | "grouped";

export interface CanTraceState {
  /** Rolling trace buffer (newest last). Lives in a ref; read on each version. */
  bufRef: React.MutableRefObject<CanTraceFrame[]>;
  /** Latest grouped rows (trace mode leaves this empty). */
  groupedRef: React.MutableRefObject<CanAggRow[]>;
  statusRef: React.MutableRefObject<CanAnalyzerStatus | null>;
  /** Derived receive rate (frames/s) from status.total deltas. */
  rateRef: React.MutableRefObject<number>;
  /** Sticky: some frames rolled off the backend ring before we read them. */
  gapRef: React.MutableRefObject<boolean>;
  /** Cumulative rows evicted from the FRONT of the local buffer (for the trace
   *  view to compensate scroll position and keep older frames pinned). */
  evictedRef: React.MutableRefObject<number>;
  /** performance.now() of the last time the frame count increased. The strip
   *  derives active/idle from this (vs ACTIVE_WINDOW_MS), not instantaneous rate. */
  lastActivityRef: React.MutableRefObject<number>;
  /** Controller health (error counters / bus-off), polled at 1 Hz. */
  healthRef: React.MutableRefObject<CanBusHealth | null>;
  version: number;
  /** Clear backend + local buffers and reset the cursor. */
  clear: () => Promise<void>;
}

export function useCanTrace(
  running: boolean,
  mode: CanMode,
  filter: CanFilterSpec,
  paused: boolean,
): CanTraceState {
  const bufRef = useRef<CanTraceFrame[]>([]);
  const groupedRef = useRef<CanAggRow[]>([]);
  const statusRef = useRef<CanAnalyzerStatus | null>(null);
  const rateRef = useRef(0);
  const gapRef = useRef(false);
  const evictedRef = useRef(0);
  const lastActivityRef = useRef(0);
  const healthRef = useRef<CanBusHealth | null>(null);
  const rateWindowRef = useRef<{ t: number; total: number }[]>([]);
  const cursorRef = useRef(0);
  const pausedRef = useRef(paused);
  const prevTotalRef = useRef(0);
  const [version, setVersion] = useState(0);

  pausedRef.current = paused;
  const filterKey = JSON.stringify(filter);

  const resetLocal = () => {
    bufRef.current = [];
    groupedRef.current = [];
    cursorRef.current = 0;
    gapRef.current = false;
    evictedRef.current = 0;
    lastActivityRef.current = 0;
    rateWindowRef.current = [];
    prevTotalRef.current = 0;
    rateRef.current = 0;
  };

  const clear = async () => {
    try {
      const next = await api.analyzerClear();
      cursorRef.current = next;
    } catch {
      /* ignore */
    }
    resetLocal();
    setVersion((v) => v + 1);
  };

  // Re-arm polling whenever the session, mode, or filter changes.
  useEffect(() => {
    if (!running) {
      resetLocal();
      statusRef.current = null;
      healthRef.current = null;
      return;
    }
    // Filter/mode changed → re-pull from the ring start with the new predicate.
    resetLocal();
    let alive = true;
    let firstPoll = true;

    const updateRate = (status: CanAnalyzerStatus) => {
      const now = performance.now();
      // fps over a rolling window (stable for sparse heartbeat traffic).
      const w = rateWindowRef.current;
      w.push({ t: now, total: status.total });
      while (w.length > 1 && now - w[0].t > RATE_WINDOW_MS) w.shift();
      if (w.length >= 2) {
        const dt = (now - w[0].t) / 1000;
        if (dt > 0) rateRef.current = Math.max(0, (status.total - w[0].total) / dt);
      }
      // Activity = frame count went up; drives the idle/active tag.
      if (status.total > prevTotalRef.current) lastActivityRef.current = now;
      prevTotalRef.current = status.total;
      statusRef.current = status;
    };

    const poll = window.setInterval(async () => {
      try {
        if (mode === "trace") {
          const reply = await api.analyzerGetTrace(cursorRef.current, MAX_BATCH, filter);
          if (!alive) return;
          cursorRef.current = reply.next_seq;
          if (reply.gap && !firstPoll) gapRef.current = true;
          if (reply.frames.length > 0) {
            const buf = bufRef.current;
            buf.push(...reply.frames);
            if (buf.length > MAX_ROWS) {
              const removed = buf.length - MAX_ROWS;
              buf.splice(0, removed);
              evictedRef.current += removed;
            }
          }
          updateRate(reply.status);
        } else {
          const reply = await api.analyzerGetAggregates(filter);
          if (!alive) return;
          groupedRef.current = reply.rows;
          updateRate(reply.status);
        }
        firstPoll = false;
      } catch {
        /* transient (e.g. just stopped) — ignore */
      }
    }, POLL_MS);

    const tick = window.setInterval(() => {
      if (alive && !pausedRef.current) setVersion((v) => v + 1);
    }, RENDER_MS);

    let healthFails = 0;
    const health = window.setInterval(async () => {
      try {
        const h = await api.analyzerBusState();
        if (alive) {
          healthRef.current = h;
          healthFails = 0;
        }
      } catch {
        // Don't let a stale chip pretend to be fresh: drop it after a few
        // consecutive failures (transient errors are still tolerated).
        if (alive && ++healthFails >= 3) healthRef.current = null;
      }
    }, HEALTH_MS);

    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.clearInterval(health);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, mode, filterKey]);

  return { bufRef, groupedRef, statusRef, rateRef, gapRef, evictedRef, lastActivityRef, healthRef, version, clear };
}
