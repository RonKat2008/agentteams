/**
 * Hybrid logical clock.
 *
 * Timestamp format: `<ISO-8601 UTC, ms, 4-digit year>-<counter, 4 digits>`,
 * e.g. `2026-10-16T21:00:00.000Z-0001`. Both parts are fixed width, so plain
 * string comparison equals causal order. Replay sorts ops by this string.
 */

const MAX_COUNTER = 9999;
const FORMAT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-(\d{4})$/;

export interface Hlc {
  /** Next timestamp; strictly greater than every earlier tick and observed remote. */
  tick(): string;
  /** Merge a remote timestamp. Malformed input is ignored. */
  observe(remote: string): void;
}

export function formatHlc(ms: number, counter: number): string {
  return `${new Date(ms).toISOString()}-${String(counter).padStart(4, '0')}`;
}

export function parseHlc(ts: string): { ms: number; counter: number } | null {
  const m = FORMAT.exec(ts);
  if (!m) return null;
  const ms = Date.parse(m[1]!);
  if (Number.isNaN(ms)) return null;
  return { ms, counter: Number(m[2]) };
}

export function createHlc(nowFn: () => number = Date.now): Hlc {
  let ms = 0;
  let counter = 0;
  const bump = (): void => {
    if (counter >= MAX_COUNTER) {
      ms += 1;
      counter = 0;
    } else counter += 1;
  };
  return {
    tick() {
      const now = nowFn();
      if (now > ms) {
        ms = now;
        counter = 0;
      } else bump();
      return formatHlc(ms, counter);
    },
    observe(remote) {
      const r = parseHlc(remote);
      if (!r) return;
      if (r.ms > ms) {
        ms = r.ms;
        counter = r.counter;
      } else if (r.ms === ms) counter = Math.max(counter, r.counter);
    },
  };
}
