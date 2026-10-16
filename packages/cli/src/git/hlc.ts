/**
 * Hybrid logical clock.
 *
 * Timestamp format: `<ISO-8601 UTC, ms, 4-digit year>-<counter, 4 digits>`,
 * e.g. `2026-10-16T21:00:00.000Z-0001`. Both parts are fixed width, so plain
 * string comparison equals causal order. Replay sorts ops by this string.
 * Valid instants are clamped to years 2000..9999 so the width never changes.
 */

const MAX_COUNTER = 9999;
const FORMAT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-(\d{4})$/;
export const MIN_HLC_MS = Date.UTC(2000, 0, 1);
export const MAX_HLC_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
/** Remote timestamps further ahead of the local wall clock than this are ignored by observe(). */
export const MAX_CLOCK_SKEW_MS = 300_000;

export interface Hlc {
  /** Next timestamp; strictly greater than every earlier tick and accepted remote. */
  tick(): string;
  /** Merge a remote timestamp. Returns false (and changes nothing) if malformed or too far in the future. */
  observe(remote: string): boolean;
}

const clamp = (ms: number): number => Math.min(MAX_HLC_MS, Math.max(MIN_HLC_MS, ms));

export function formatHlc(ms: number, counter: number): string {
  return `${new Date(clamp(ms)).toISOString()}-${String(counter).padStart(4, '0')}`;
}

/** Strict: only canonical strings produced by formatHlc within the valid range parse. */
export function parseHlc(ts: unknown): { ms: number; counter: number } | null {
  if (typeof ts !== 'string') return null;
  const m = FORMAT.exec(ts);
  if (!m) return null;
  const ms = Date.parse(m[1]!);
  if (Number.isNaN(ms) || ms < MIN_HLC_MS || ms > MAX_HLC_MS) return null;
  const counter = Number(m[2]);
  return formatHlc(ms, counter) === ts ? { ms, counter } : null;
}

export function createHlc(nowFn: () => number = Date.now): Hlc {
  let ms = MIN_HLC_MS;
  let counter = -1;
  return {
    tick() {
      const now = clamp(nowFn());
      if (now > ms) {
        ms = now;
        counter = 0;
      } else if (counter >= MAX_COUNTER) {
        if (ms >= MAX_HLC_MS) throw new Error('hybrid logical clock exhausted');
        ms += 1;
        counter = 0;
      } else counter += 1;
      return formatHlc(ms, counter);
    },
    observe(remote) {
      const r = parseHlc(remote);
      if (!r || r.ms > nowFn() + MAX_CLOCK_SKEW_MS) return false;
      if (r.ms > ms) {
        ms = r.ms;
        counter = r.counter;
      } else if (r.ms === ms) counter = Math.max(counter, r.counter);
      return true;
    },
  };
}
