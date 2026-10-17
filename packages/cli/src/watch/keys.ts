/** Raw-mode stdin chunks to dashboard keys. A chunk may carry several keys (fast typing, pasted input). */

export type WatchKey =
  | 'quit' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end' | 'refresh' | 'toggleActive' | 'help' | 'escape';

const SEQUENCES: [string, WatchKey][] = [
  ['\u001b[A', 'up'], ['\u001bOA', 'up'], ['\u001b[B', 'down'], ['\u001bOB', 'down'],
  ['\u001b[5~', 'pageUp'], ['\u001b[6~', 'pageDown'],
  ['\u001b[H', 'home'], ['\u001bOH', 'home'], ['\u001b[1~', 'home'],
  ['\u001b[F', 'end'], ['\u001bOF', 'end'], ['\u001b[4~', 'end'],
];

const SINGLE: Record<string, WatchKey> = {
  q: 'quit', Q: 'quit', '\u0003': 'quit', '\u0004': 'quit',
  k: 'up', j: 'down', ' ': 'pageDown', b: 'pageUp', g: 'home', G: 'end',
  r: 'refresh', R: 'refresh', a: 'toggleActive', A: 'toggleActive', '?': 'help', h: 'help',
};

/** Unknown escape sequences (other keys, mouse reports) are skipped whole. */
function skipUnknownEscape(data: string, i: number): number {
  const m = /^\u001b(\[[0-9;?]*[ -/]*[@-~]|O.)?/.exec(data.slice(i));
  return i + (m?.[0].length ?? 1);
}

export function parseKeys(data: string): WatchKey[] {
  const keys: WatchKey[] = [];
  let i = 0;
  while (i < data.length) {
    const seq = SEQUENCES.find(([s]) => data.startsWith(s, i));
    if (seq) { keys.push(seq[1]); i += seq[0].length; continue; }
    if (data[i] === '\u001b') {
      if (i === data.length - 1) keys.push('escape');
      i = skipUnknownEscape(data, i);
      continue;
    }
    const key = SINGLE[data[i]!];
    if (key) keys.push(key);
    i++;
  }
  return keys;
}
