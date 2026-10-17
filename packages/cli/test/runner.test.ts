import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realRunner } from '../src/run/runner.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readOr = (file: string): string => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

describe('realRunner', () => {
  it('a foreground run stops the tool and everything it started when its signal aborts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'at-runner-'));
    const pidFile = join(dir, 'grandchild.pid');
    const ac = new AbortController();
    const started = realRunner.start('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], {
      cwd: dir, logPath: join(dir, 'run.log'), detach: false, echo: false, signal: ac.signal,
    });
    await expect.poll(() => readOr(pidFile)).not.toBe('');
    const grandchild = Number(readOr(pidFile));
    ac.abort('SIGTERM');
    expect((await started).code).toBe(143);
    await expect.poll(() => alive(grandchild)).toBe(false);
  });
});
