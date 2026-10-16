import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTools, which, type DetectFs } from '../src/tui/detect.js';

const HOME = '/home/ada';

/** In-memory fs: a set of executable files, a set of directories, and directory listings. */
function fakeFs(opts: { exes?: string[]; dirs?: string[]; listings?: Record<string, string[]> } = {}): DetectFs & { probed: string[] } {
  const probed: string[] = [];
  const exes = new Set(opts.exes ?? []);
  const dirs = new Set(opts.dirs ?? []);
  return {
    probed,
    isExecutable: async (p) => { probed.push(p); return exes.has(p); },
    isDir: async (p) => { probed.push(p); return dirs.has(p); },
    listDir: async (p) => { probed.push(p); return opts.listings?.[p] ?? []; },
  };
}

const detected = (choices: { tool: string; detected: boolean }[]) => choices.filter((c) => c.detected).map((c) => c.tool);

describe('which', () => {
  it('returns the first PATH entry holding an executable', async () => {
    const fs = fakeFs({ exes: ['/opt/bin/claude', '/usr/bin/claude'] });
    const env = { PATH: ['/usr/local/bin', '/opt/bin', '/usr/bin'].join(':') };
    expect(await which('claude', { env, homedir: HOME, platform: 'linux', fs })).toBe('/opt/bin/claude');
  });

  it('returns null when PATH is empty or the binary is missing', async () => {
    expect(await which('claude', { env: {}, homedir: HOME, platform: 'linux', fs: fakeFs() })).toBeNull();
    expect(await which('claude', { env: { PATH: '/bin' }, homedir: HOME, platform: 'linux', fs: fakeFs() })).toBeNull();
  });

  it('tries PATHEXT suffixes on Windows', async () => {
    const fs = fakeFs({ exes: [join('C:\\tools', 'codex.CMD')] });
    const env = { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' };
    expect(await which('codex', { env, homedir: HOME, platform: 'win32', fs })).toBe(join('C:\\tools', 'codex.CMD'));
  });
});

describe('detectTools', () => {
  it('lists every tool, with nothing detected on a bare machine', async () => {
    const choices = await detectTools({ env: { PATH: '/usr/bin' }, homedir: HOME, platform: 'linux', fs: fakeFs() });
    expect(detected(choices)).toEqual([]);
    expect(choices.map((c) => c.tool)).toContain('other');
    expect(choices).toHaveLength(11);
  });

  it('detects binaries on PATH and puts them first in ToolKind order', async () => {
    const fs = fakeFs({ exes: ['/usr/bin/gemini', '/usr/bin/codex', '/usr/bin/cursor-agent'] });
    const choices = await detectTools({ env: { PATH: '/usr/bin' }, homedir: HOME, platform: 'linux', fs });
    expect(detected(choices)).toEqual(['codex', 'cursor', 'gemini']);
    expect(choices.slice(0, 3).map((c) => c.why)).toEqual(['codex on PATH', 'cursor-agent on PATH', 'gemini on PATH']);
    expect(choices[3]!.detected).toBe(false);
  });

  it('detects config dirs under HOME, honoring CODEX_HOME and XDG_CONFIG_HOME', async () => {
    const fs = fakeFs({
      dirs: [join(HOME, '.claude'), '/srv/codex', '/xdg/opencode', join(HOME, '.factory'), join(HOME, '.codeium', 'windsurf')],
    });
    const env = { CODEX_HOME: '/srv/codex', XDG_CONFIG_HOME: '/xdg' };
    const choices = await detectTools({ env, homedir: HOME, platform: 'linux', fs });
    expect(detected(choices)).toEqual(['claude', 'codex', 'droid', 'opencode', 'windsurf']);
    expect(choices[0]!.why).toBe('~/.claude');
  });

  it('detects cline and roo from VS Code extension folders', async () => {
    const fs = fakeFs({
      listings: {
        [join(HOME, '.vscode/extensions')]: ['saoudrizwan.claude-dev-3.1.0'],
        [join(HOME, '.cursor/extensions')]: ['RooVeterinaryInc.roo-cline-3.0.0'],
      },
    });
    const choices = await detectTools({ env: {}, homedir: HOME, platform: 'linux', fs });
    expect(detected(choices)).toEqual(['cline', 'roo']);
  });

  it('only probes paths under the given HOME and PATH', async () => {
    const fs = fakeFs();
    await detectTools({ env: { PATH: '/fake/bin' }, homedir: HOME, platform: 'linux', fs });
    expect(fs.probed.every((p) => p.startsWith(HOME) || p.startsWith('/fake/bin'))).toBe(true);
  });
});
