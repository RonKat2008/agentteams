import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestCli, type TestCli } from './helpers.js';

const runTui = vi.fn(async () => 0);
vi.mock('../src/tui/menu.js', () => ({ runTui }));

const { main } = await import('../src/main.js');

let t: TestCli;
afterEach(() => { t?.cleanup(); runTui.mockClear(); });

describe('menu entry points', () => {
  it('bare agentteams in a terminal opens the menu', async () => {
    t = makeTestCli({ isTTY: true });
    expect(await main(['node', 'agentteams'], t.deps)).toBe(0);
    expect(runTui).toHaveBeenCalledOnce();
  });

  it('bare agentteams without a TTY prints help and does not open the menu', async () => {
    t = makeTestCli({ isTTY: false });
    await main(['node', 'agentteams'], t.deps);
    expect(runTui).not.toHaveBeenCalled();
    expect([...t.out, ...t.err].join('\n')).toContain('Usage: agentteams');
  });

  it('agentteams tui and its setup alias open the menu', async () => {
    t = makeTestCli({ isTTY: true });
    expect(await main(['node', 'agentteams', 'tui'], t.deps)).toBe(0);
    expect(await main(['node', 'agentteams', 'setup'], t.deps)).toBe(0);
    expect(runTui).toHaveBeenCalledTimes(2);
  });

  it('agentteams tui refuses without a TTY', async () => {
    t = makeTestCli({ isTTY: false });
    expect(await main(['node', 'agentteams', 'tui'], t.deps)).toBe(1);
    expect(t.err.join('\n')).toMatch(/needs an interactive terminal/);
    expect(runTui).not.toHaveBeenCalled();
  });

  it('subcommands and --help never open the menu', async () => {
    t = makeTestCli({ isTTY: true });
    await main(['node', 'agentteams', '--help'], t.deps);
    expect(runTui).not.toHaveBeenCalled();
  });
});
