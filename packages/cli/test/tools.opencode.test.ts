import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { opencodeAdapter, OPENCODE_PLUGIN_PATH } from '../src/tools/opencode.js';
import { OPENCODE_PLUGIN_MARKER, opencodeDialect, renderOpencodePlugin } from '../src/tools/opencodePlugin.js';
import { getAdapter } from '../src/tools/registry.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let cred: Credential;
let exclude: string;

beforeEach(() => {
  t = makeTestCli();
  exclude = join(t.root, 'exclude');
  t.deps.exec = async (_c, a) =>
    a.includes('--git-path') ? { code: 0, stdout: `${exclude}\n`, stderr: '' } : { code: 0, stdout: `${t.deps.cwd}\n`, stderr: '' };
  cred = { repoPath: t.deps.cwd, tool: 'opencode', hubUrl: 'http://h', teamName: 'dev-squad', agentName: 'a', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

const repoFile = (p: string): string => join(t.deps.cwd, p);
const snapshot = (): string[] => ['opencode.json', OPENCODE_PLUGIN_PATH, 'AGENTS.md'].map((p) => readFileSync(repoFile(p), 'utf8'));

describe('opencode dialect', () => {
  it('is registered and renders context/block/none', () => {
    expect(getAdapter('opencode')).toBe(opencodeAdapter);
    expect(opencodeDialect.render({ type: 'context', event: 'session-start', text: 'hi' }, {})).toEqual({ stdout: '{"context":"hi"}', exitCode: 0 });
    expect(opencodeDialect.render({ type: 'block', text: 'do it' }, {})).toEqual({ stdout: '{"block":"do it"}', exitCode: 0 });
    expect(opencodeDialect.render({ type: 'none' }, {})).toEqual({ stdout: '', exitCode: 0 });
    expect(opencodeDialect.isStopLoop({ stop_hook_active: true })).toBe(true);
    expect(opencodeDialect.readCwd({ cwd: '/r' })).toBe('/r');
  });
});

describe('opencode install', () => {
  it('writes mcp entry, plugin and AGENTS.md; git-excludes the machine-specific files; no api key', async () => {
    const r = await opencodeAdapter.install(t.deps, cred);
    expect(r.warnings).toEqual([]);
    const cfg = JSON.parse(readFileSync(repoFile('opencode.json'), 'utf8'));
    expect(cfg.mcp.agentteams.type).toBe('local');
    expect(cfg.mcp.agentteams.enabled).toBe(true);
    const cmd: string[] = cfg.mcp.agentteams.command;
    expect(cmd.slice(-5)).toEqual(['mcp', '--tool', 'opencode', '--repo', t.deps.cwd]);
    const plugin = readFileSync(repoFile(OPENCODE_PLUGIN_PATH), 'utf8');
    expect(plugin.startsWith(OPENCODE_PLUGIN_MARKER)).toBe(true);
    expect(readFileSync(repoFile('AGENTS.md'), 'utf8')).toContain('agentteams:start');
    const ex = readFileSync(exclude, 'utf8').split('\n');
    expect(ex).toContain('opencode.json');
    expect(ex).toContain(OPENCODE_PLUGIN_PATH);
    for (const f of snapshot()) expect(f).not.toContain('at_SECRET');
  });

  it('is byte-identical on reinstall', async () => {
    await opencodeAdapter.install(t.deps, cred);
    const first = snapshot();
    const exFirst = readFileSync(exclude, 'utf8');
    await opencodeAdapter.install(t.deps, cred);
    expect(snapshot()).toEqual(first);
    expect(readFileSync(exclude, 'utf8')).toBe(exFirst);
  });

  it('preserves user keys and servers, and warns instead of excluding a pre-existing opencode.json', async () => {
    writeFileSync(repoFile('opencode.json'), JSON.stringify({ $schema: 'x', theme: 'dark', mcp: { mine: { type: 'remote', url: 'https://u' } } }));
    const r = await opencodeAdapter.install(t.deps, cred);
    const cfg = JSON.parse(readFileSync(repoFile('opencode.json'), 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.$schema).toBe('x');
    expect(cfg.mcp.mine).toEqual({ type: 'remote', url: 'https://u' });
    expect(cfg.mcp.agentteams).toBeDefined();
    expect(r.warnings.some((w) => w.includes('machine-specific'))).toBe(true);
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').not.toContain('opencode.json');
  });

  it('malformed opencode.json: warning, untouched', async () => {
    writeFileSync(repoFile('opencode.json'), '{nope');
    const r = await opencodeAdapter.install(t.deps, cred);
    expect(readFileSync(repoFile('opencode.json'), 'utf8')).toBe('{nope');
    expect(r.warnings.some((w) => w.includes('opencode.json is not valid JSON'))).toBe(true);
  });

  it('does not overwrite a user-owned plugin file', async () => {
    mkdirSync(join(t.deps.cwd, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(repoFile(OPENCODE_PLUGIN_PATH), 'export const Mine = async () => ({})\n');
    const r = await opencodeAdapter.install(t.deps, cred);
    expect(readFileSync(repoFile(OPENCODE_PLUGIN_PATH), 'utf8')).toContain('Mine');
    expect(r.warnings.some((w) => w.includes('not managed'))).toBe(true);
  });
});

describe('generated opencode plugin (real module, fake CLI + fake client)', () => {
  let dir: string;
  let calls: Array<{ path: { id: string }; body: { noReply?: boolean; parts: Array<{ text: string }> } }>;
  const client = () => ({
    session: { prompt: async (a: (typeof calls)[number]) => { calls.push(a); return {}; } },
  });

  async function load(replies: Record<string, unknown>) {
    dir = join(t.root, 'plug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    // Fake CLI: prints the canned reply for argv[3] (the neutral event); echoes stdin into $LOG.
    const cli = join(dir, 'fakecli.mjs');
    writeFileSync(cli, `import { appendFileSync } from 'node:fs';
let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{
  appendFileSync(${JSON.stringify(join(dir, 'log.txt'))}, process.argv.slice(2).join(' ')+' '+s+'\\n');
  // Like the real hub: a stop hook flagged as a loop never blocks.
  if(process.argv[3]==='stop' && JSON.parse(s||'{}').stop_hook_active===true) return;
  const r=${JSON.stringify(replies)}[process.argv[3]]; if(r!==undefined) process.stdout.write(JSON.stringify(r));
});`);
    const file = join(dir, 'agentteams.mjs');
    writeFileSync(file, renderOpencodePlugin(process.execPath, cli));
    const mod = await import(pathToFileURL(file).href);
    expect(Object.keys(mod)).toEqual(['AgentTeams']);
    calls = [];
    return mod.AgentTeams({ client: client(), directory: '/the/repo' });
  }

  it('injects session-start context with noReply and passes cwd on stdin', async () => {
    const hooks = await load({ 'session-start': { context: 'team status' } });
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1' } } } });
    expect(calls).toEqual([{ path: { id: 's1' }, body: { noReply: true, parts: [{ type: 'text', text: 'team status' }] } }]);
    const log = readFileSync(join(dir, 'log.txt'), 'utf8');
    expect(log).toContain('hook session-start --tool opencode --agentteams-managed {"cwd":"/the/repo"}');
  });

  it('injects after tool use and stays quiet when there is nothing', async () => {
    const hooks = await load({ 'post-tool-use': { context: 'new msg' } });
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.noReply).toBe(true);
    const quiet = await load({});
    await quiet['tool.execute.after']({ tool: 'bash', sessionID: 's1' });
    await quiet.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    expect(calls).toEqual([]);
  });

  it('on idle re-prompts (real prompt) once and marks the follow-up idle as a stop loop', async () => {
    const hooks = await load({ stop: { block: 'do the thing' } });
    const idle = { event: { type: 'session.idle', properties: { sessionID: 's1' } } };
    await hooks.event(idle);
    expect(calls).toEqual([{ path: { id: 's1' }, body: { parts: [{ type: 'text', text: 'do the thing' }] } }]);
    await hooks.event(idle); // idle after our own prompt: a loop, never blocks
    expect(calls).toHaveLength(1);
    const log = readFileSync(join(dir, 'log.txt'), 'utf8').trim().split('\n');
    expect(log[0]).toContain('"stop_hook_active":false');
    expect(log[1]).toContain('"stop_hook_active":true');
  });

  it('delivers a repeated identical command consumed by a later, non-loop idle (2 consumed -> 2 delivered)', async () => {
    const hooks = await load({ stop: { block: 'run the tests' } });
    const idle = { event: { type: 'session.idle', properties: { sessionID: 's1' } } };
    await hooks.event(idle); // consumes command #1 -> prompt
    await hooks.event(idle); // loop idle after our prompt -> nothing
    await hooks.event(idle); // later idle: hub consumed command #2 (same text) -> must prompt again
    expect(calls.map((c) => c.body.parts[0]?.text)).toEqual(['run the tests', 'run the tests']);
  });

  it('ignores sub-agent sessions at start and survives a broken CLI', async () => {
    const hooks = await load({ 'session-start': { context: 'x' } });
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'c', parentID: 'p' } } } });
    expect(calls).toEqual([]);
    const broken = await (await import(pathToFileURL(join(dir, 'agentteams.mjs')).href)).AgentTeams({ client: client(), directory: '/x' });
    expect(typeof broken.event).toBe('function');
  });
});
