import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHub } from '@agentteams/hub';
import { HubClient } from '../src/hubClient.js';
import { saveCredential } from '../src/credentials.js';
import { runHook } from '../src/hooks.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let dir: string;
let hub: Awaited<ReturnType<typeof startHub>>;
let ronitKey: string;
const repo = '/work/my-app';

beforeEach(async () => {
  t = makeTestCli();
  dir = mkdtempSync(join(tmpdir(), 'agentteams-hooks-'));
  hub = await startHub({ dbPath: join(dir, 'hub.db'), port: 0 });
  const anon = new HubClient(hub.url);
  const created = await anon.createTeam({ name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
  const ash = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'ash', tool: 'codex' });
  ronitKey = created.apiKey;
  await saveCredential(t.deps, { repoPath: repo, tool: 'codex', hubUrl: hub.url, teamName: 'dev-squad', agentName: 'ash-codex', apiKey: ash.apiKey, createdAt: '2026-01-01T00:00:00.000Z' });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
  t.cleanup();
});

/** Sends a message as ronit-claude (orchestrator) via the hub's MCP send_message tool. */
async function ronitSend(to: string, body: string, kind: 'command' | 'fyi') {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${ronitKey}` } } }));
  await client.callTool({ name: 'send_message', arguments: { to, body, kind } });
  await client.close();
}

const ctxOf = (stdout: string) =>
  (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;

describe('runHook', () => {
  it('prints nothing for repos without agentteams credentials', async () => {
    expect(await runHook('user-prompt-submit', JSON.stringify({ cwd: '/somewhere/else' }), 'codex', t.deps)).toEqual({ stdout: '', exitCode: 0 });
  });

  it('session-start injects status and unread messages', async () => {
    await ronitSend('ash-codex', 'Build /login', 'command');
    const out = ctxOf((await runHook('session-start', JSON.stringify({ cwd: `${repo}/src` }), 'codex', t.deps)).stdout);
    expect(out.hookEventName).toBe('SessionStart');
    expect(out.additionalContext).toContain('you are ash-codex in team "dev-squad"');
    expect(out.additionalContext).toContain('- Command from ronit-claude (orchestrator): Build /login');
  });

  it('post-tool-use and user-prompt-submit deliver each message once', async () => {
    await ronitSend('ash-codex', 'heads up', 'fyi');
    const first = await runHook('post-tool-use', JSON.stringify({ cwd: repo }), 'codex', t.deps);
    expect(ctxOf(first.stdout)).toMatchObject({ hookEventName: 'PostToolUse' });
    expect(ctxOf(first.stdout).additionalContext).toContain('heads up');
    expect((await runHook('user-prompt-submit', JSON.stringify({ cwd: repo }), 'codex', t.deps)).stdout).toBe('');
  });

  it('stop blocks only for unread commands, and never when stop_hook_active', async () => {
    await ronitSend('ash-codex', 'just fyi', 'fyi');
    expect((await runHook('stop', JSON.stringify({ cwd: repo }), 'codex', t.deps)).stdout).toBe('');

    await ronitSend('ash-codex', 'Now do task 5', 'command');
    expect((await runHook('stop', JSON.stringify({ cwd: repo, stop_hook_active: true }), 'codex', t.deps)).stdout).toBe('');
    const blocked = JSON.parse((await runHook('stop', JSON.stringify({ cwd: repo }), 'codex', t.deps)).stdout) as { decision: string; reason: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('Now do task 5');
    expect(blocked.reason).toContain('just fyi');
    expect((await runHook('stop', JSON.stringify({ cwd: repo }), 'codex', t.deps)).stdout).toBe('');
  });

  it('stays silent and fast when the hub is down or stdin is garbage', async () => {
    await hub.close();
    hub = await startHub({ dbPath: join(dir, 'other.db'), port: 0 }); // credential still points at the dead port
    const started = Date.now();
    expect(await runHook('session-start', 'not json', 'codex', { ...t.deps, cwd: repo })).toEqual({ stdout: '', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
