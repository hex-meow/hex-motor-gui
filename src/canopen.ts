// Pure, stateless CANopen (CiA-301) classification for the analyzer's
// "interpretation" toggle. Frontend-side on purpose: labels are bilingual and
// the toggle must flip instantly with no backend round-trip. Shallow decode —
// function-code + node for every frame, plus EMCY code / heartbeat state / NMT
// command / SDO command-specifier + index:sub on initiate frames. No stateful
// multi-segment SDO reassembly (deferred).

export type CanopenKind =
  | "NMT"
  | "SYNC"
  | "EMCY"
  | "TIME"
  | "TPDO"
  | "RPDO"
  | "SDO_TX"
  | "SDO_RX"
  | "HB"
  | "LSS"
  | "RESERVED"
  | "RAW_EXT";

export interface Decoded {
  kind: CanopenKind;
  /** CANopen node id, when the COB-ID carries one. */
  node?: number;
  /** PDO number 1..4, for TPDO/RPDO. */
  pdo?: number;
  /** Short label for the ID column, e.g. "TPDO1", "SDO↑", "HB". */
  label: string;
  /** Optional one-line decode detail (EMCY code, SDO index, NMT command, …). */
  detail?: string;
}

const NMT_CS: Record<number, string> = {
  0x01: "Start",
  0x02: "Stop",
  0x80: "Pre-op",
  0x81: "Reset node",
  0x82: "Reset comm",
};

const HB_STATE: Record<number, string> = {
  0x00: "Boot-up",
  0x04: "Stopped",
  0x05: "Operational",
  0x7f: "Pre-op",
};

const hex = (n: number, w = 0) => "0x" + n.toString(16).toUpperCase().padStart(w, "0");

function decodeEmcy(node: number, d: number[]): Decoded {
  const label = `EMCY·${node}`;
  if (d.length >= 3) {
    const code = d[0] | (d[1] << 8);
    return { kind: "EMCY", node, label, detail: `code ${hex(code, 4)} reg ${hex(d[2], 2)}` };
  }
  return { kind: "EMCY", node, label };
}

function decodeSdo(kind: "SDO_TX" | "SDO_RX", node: number, d: number[]): Decoded {
  const up = kind === "SDO_TX";
  const label = up ? `SDO↑·${node}` : `SDO↓·${node}`;
  if (d.length < 1) return { kind, node, label };
  const cs = (d[0] >> 5) & 0x7;
  // Abort (cs == 4) in either direction: 32-bit abort code in bytes 4..8.
  if (cs === 4) {
    const idx = d.length >= 4 ? d[1] | (d[2] << 8) : 0;
    const sub = d.length >= 4 ? d[3] : 0;
    const abort =
      d.length >= 8 ? (d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24)) >>> 0 : 0;
    return { kind, node, label, detail: `ABORT ${hex(idx, 4)}:${hex(sub, 2)} = ${hex(abort, 8)}` };
  }
  // Initiate frames carry index:sub in bytes 1..4. Command-specifier decode per
  // CiA-301: server (scs, up) 2=upload-init-resp(read), 3=download-init-resp
  // (write ack), 0=upload-segment; client (ccs, down) 1=download-init(write),
  // 2=upload-init(read req), 0=download-segment, 3=upload-segment req.
  if (d.length >= 4) {
    const idx = d[1] | (d[2] << 8);
    const sub = d[3];
    const op = up
      ? cs === 2
        ? "read"
        : cs === 3
          ? "write-ack"
          : cs === 0
            ? "upload-seg"
            : "resp"
      : cs === 1
        ? "write"
        : cs === 2
          ? "read-req"
          : cs === 0
            ? "write-seg"
            : "req";
    return { kind, node, label, detail: `${op} ${hex(idx, 4)}:${hex(sub, 2)}` };
  }
  return { kind, node, label };
}

/** Classify a COB-ID (+ payload) per the CiA-301 default connection set. */
export function decodeCanopen(idRaw: number, extended: boolean, data: number[]): Decoded {
  if (extended) {
    return { kind: "RAW_EXT", label: hex(idRaw) + " (ext)" };
  }
  const id = idRaw & 0x7ff;
  const fc = id & 0x780;
  const node = id & 0x7f;

  if (id === 0x000) {
    const cs = data.length >= 1 ? data[0] : 0;
    const target = data.length >= 2 ? data[1] : 0;
    const csName = NMT_CS[cs] ?? hex(cs, 2);
    return { kind: "NMT", label: "NMT", detail: `${csName} → ${target === 0 ? "all" : "node " + target}` };
  }
  if (id === 0x080) return { kind: "SYNC", label: "SYNC" };
  if (id === 0x100) return { kind: "TIME", label: "TIME" };
  if (id === 0x7e4 || id === 0x7e5) return { kind: "LSS", label: id === 0x7e5 ? "LSS↓" : "LSS↑" };

  switch (fc) {
    case 0x080:
      return decodeEmcy(node, data); // 0x081..0x0FF (0x080 handled above)
    case 0x180:
      return { kind: "TPDO", node, pdo: 1, label: `TPDO1·${node}` };
    case 0x200:
      return { kind: "RPDO", node, pdo: 1, label: `RPDO1·${node}` };
    case 0x280:
      return { kind: "TPDO", node, pdo: 2, label: `TPDO2·${node}` };
    case 0x300:
      return { kind: "RPDO", node, pdo: 2, label: `RPDO2·${node}` };
    case 0x380:
      return { kind: "TPDO", node, pdo: 3, label: `TPDO3·${node}` };
    case 0x400:
      return { kind: "RPDO", node, pdo: 3, label: `RPDO3·${node}` };
    case 0x480:
      return { kind: "TPDO", node, pdo: 4, label: `TPDO4·${node}` };
    case 0x500:
      return { kind: "RPDO", node, pdo: 4, label: `RPDO4·${node}` };
    case 0x580:
      return decodeSdo("SDO_TX", node, data);
    case 0x600:
      return decodeSdo("SDO_RX", node, data);
    case 0x700: {
      const st = data.length >= 1 ? HB_STATE[data[0] & 0x7f] ?? hex(data[0], 2) : "?";
      return { kind: "HB", node, label: `HB·${node}`, detail: st };
    }
    default:
      return { kind: "RESERVED", label: hex(id, 3) };
  }
}

/** Antd tag color per CANopen kind, for the trace/grouped views. */
export function kindColor(kind: CanopenKind): string {
  switch (kind) {
    case "NMT":
      return "magenta";
    case "SYNC":
      return "purple";
    case "EMCY":
      return "red";
    case "TIME":
      return "geekblue";
    case "TPDO":
      return "green";
    case "RPDO":
      return "cyan";
    case "SDO_TX":
    case "SDO_RX":
      return "gold";
    case "HB":
      return "blue";
    case "LSS":
      return "volcano";
    default:
      return "default";
  }
}
