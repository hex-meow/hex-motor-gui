export const fmtNum = (x: number | null | undefined, digits = 3): string =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(digits);

export const fmtHex = (x: number | null | undefined, width = 4): string =>
  x === null || x === undefined
    ? "—"
    : "0x" + x.toString(16).toUpperCase().padStart(width, "0");

export const nid2hex = (nid: number): string =>
  "0x" + nid.toString(16).toUpperCase().padStart(2, "0");

/** Parse a node id from hex (0x..) or decimal; throws if out of 1..127. */
export function parseNid(s: string): number {
  const t = String(s).trim();
  const n =
    t.toLowerCase().startsWith("0x") ? parseInt(t.slice(2), 16) : Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 127) {
    // Locale-neutral: surfaces in both zh and en result logs.
    throw new Error(`node id must be 1..127 (节点号需在 1..127), got '${s}'`);
  }
  return n;
}
