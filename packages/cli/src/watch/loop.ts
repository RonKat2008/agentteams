/**
 * The dashboard's I/O loop: polls `fetch` on an interval (backing off on errors), redraws on a short tick
 * (clock, ages, spinner), on keys and on resize, and always hands the terminal back through `screen.restore`.
 * Polling never blocks drawing: a slow hub just leaves the last snapshot on screen.
 */
import { parseKeys, type WatchKey } from './keys.js';
import { messageOf, type Snapshot, type WatchState } from './model.js';
import { SPINNER_MS } from './panels.js';
import { maxFeedScroll, renderFrame, type RenderOpts } from './render.js';

/** The terminal, as the loop needs it (real one: terminal.ts; tests: a fake). */
export interface Screen {
  size(): { width: number; height: number };
  write(s: string): void;
  /** Alternate screen on, cursor hidden, raw input. */
  enter(): void;
  /** Undo enter(); must be safe to call more than once. */
  restore(): void;
  onKey(cb: (data: string) => void): () => void;
  onResize(cb: () => void): () => void;
}

export interface WatchLoopOpts {
  screen: Screen;
  fetch: () => Promise<Snapshot>;
  state: WatchState;
  intervalMs: number;
  color: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

const MAX_BACKOFF_MS = 60_000;
const BEGIN_SYNC = '\u001b[?2026h';
const END_SYNC = '\u001b[0m\u001b[?2026l';
const CLEAR = '\u001b[2J';

/**
 * The escape sequences that turn the screen showing `prev` into `frame`: every line positioned absolutely and
 * only lines that differ rewritten (all of them after a clear), inside a synchronized update, so a redraw never
 * scrolls or flickers. Returns '' when nothing changed.
 */
export function frameToScreen(frame: string, prev: readonly string[] | null): string {
  const lines = frame.split('\n');
  const changed = lines.map((l, i) => (prev && prev[i] === l ? '' : `\u001b[${i + 1};1H${l}\u001b[0m`)).join('');
  if (changed === '') return '';
  return `${BEGIN_SYNC}${prev ? '' : CLEAR}${changed}${END_SYNC}`;
}

class WatchLoop {
  private state: WatchState;
  /** Lines on screen now; null forces a clear and a full redraw. */
  private shown: string[] | null = null;
  private failures = 0;
  private inFlight = false;
  private stopped = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private cleanups: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly o: WatchLoopOpts, private readonly done: (err?: unknown) => void) {
    this.state = o.state;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.o.screen.enter();
    this.cleanups.push(
      this.o.screen.onKey((d) => this.guard(() => this.keys(parseKeys(d)))),
      this.o.screen.onResize(() => this.guard(() => this.draw(true))),
    );
    if (this.o.signal) {
      const onAbort = () => this.stop();
      this.o.signal.addEventListener('abort', onAbort, { once: true });
      this.cleanups.push(() => this.o.signal?.removeEventListener('abort', onAbort));
      if (this.o.signal.aborted) return this.stop();
    }
    this.tickTimer = setInterval(() => this.guard(() => this.draw()), SPINNER_MS);
    this.guard(() => this.draw(true));
    void this.poll();
  }

  private opts(): RenderOpts {
    const { width, height } = this.o.screen.size();
    return { width: Math.max(1, width), height: Math.max(1, height), color: this.o.color, now: this.now() };
  }

  private draw(clear = false): void {
    if (this.stopped) return;
    const frame = renderFrame(this.state, this.opts());
    const out = frameToScreen(frame, clear ? null : this.shown);
    this.shown = frame.split('\n');
    if (out) this.o.screen.write(out);
  }

  private async poll(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    clearTimeout(this.pollTimer);
    let delay = this.o.intervalMs;
    try {
      const snapshot = await this.o.fetch();
      this.failures = 0;
      const { error: _e, retryAt: _r, ...rest } = this.state;
      this.state = { ...rest, snapshot, updatedAt: this.now() };
    } catch (err) {
      this.failures++;
      delay = Math.min(this.o.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
      this.state = { ...this.state, error: messageOf(err), retryAt: this.now() + delay };
    } finally {
      this.inFlight = false;
    }
    if (this.stopped) return;
    this.guard(() => this.draw());
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private keys(keys: WatchKey[]): void {
    for (const k of keys) {
      if (k === 'quit') return this.stop();
      if (k === 'refresh') void this.poll();
      else this.state = this.apply(k);
    }
    this.draw();
  }

  private apply(k: WatchKey): WatchState {
    const s = this.state;
    const page = Math.max(1, Math.floor(this.opts().height / 2));
    const max = () => maxFeedScroll(s, this.opts());
    const scrollTo = (n: number): WatchState => ({ ...s, scroll: Math.max(0, Math.min(n, max())) });
    switch (k) {
      case 'up': return scrollTo(s.scroll - 1);
      case 'down': return scrollTo(s.scroll + 1);
      case 'pageUp': return scrollTo(s.scroll - page);
      case 'pageDown': return scrollTo(s.scroll + page);
      case 'home': return scrollTo(0);
      case 'end': return scrollTo(max());
      case 'toggleActive': return { ...s, onlyActive: !s.onlyActive };
      case 'help': return { ...s, help: !s.help };
      case 'escape': return { ...s, help: false };
      default: return s;
    }
  }

  /** Any error in a callback stops the loop (restoring the terminal) and rejects runWatchLoop. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.stop(err);
    }
  }

  stop(err?: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.tickTimer);
    for (const c of this.cleanups) c();
    try {
      this.o.screen.restore();
    } finally {
      this.done(err);
    }
  }
}

/** Runs the dashboard until q / Ctrl+C or `signal` aborts. The terminal is restored on every exit path. */
export function runWatchLoop(o: WatchLoopOpts): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const loop = new WatchLoop(o, (err) => (err === undefined ? resolve() : reject(err)));
    try {
      loop.start();
    } catch (err) {
      loop.stop(err);
    }
  });
}
