const ESC = '\u001b[';
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const AGENT_COLORS = [36, 32, 33, 34, 35, 91] as const;

export interface Palette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  gray: (s: string) => string;
  magenta: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
  /** Colors an agent name with a stable color derived from the name. */
  agent: (s: string) => string;
}

const wrap = (code: number, close: number) => (s: string) => `${ESC}${code}m${s}${ESC}${close}m`;

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h;
}

const identity = (s: string) => s;

export function makePalette(enabled: boolean): Palette {
  if (!enabled) return { dim: identity, bold: identity, green: identity, yellow: identity, gray: identity, magenta: identity, red: identity, cyan: identity, agent: identity };
  return {
    dim: wrap(2, 22), bold: wrap(1, 22), green: wrap(32, 39), yellow: wrap(33, 39), gray: wrap(90, 39), magenta: wrap(35, 39), red: wrap(31, 39), cyan: wrap(36, 39),
    agent: (s) => wrap(AGENT_COLORS[hash(s) % AGENT_COLORS.length]!, 39)(s),
  };
}

/** True when stdout is a TTY and NO_COLOR is unset, or FORCE_COLOR is set to anything but "0". */
export function colorEnabled(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return stdoutIsTTY && env.NO_COLOR === undefined;
}

export const visibleWidth = (s: string): number => [...s.replace(ANSI, '')].length;

/** Pads on visible width so escape codes do not skew alignment. */
export function padVisible(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleWidth(s)));
}
