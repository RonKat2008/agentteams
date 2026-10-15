import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestContext, seedTeam, type SeededTeam, type TestEnv } from './helpers.js';
import { createApp } from '../src/http/app.js';

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let team: SeededTeam;
const clients: Client[] = [];

beforeEach(async () => {
  env = await makeTestContext();
  app = createApp(env.ctx);
  team = await seedTeam(env);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await env.close();
});

async function connect(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
    fetch: (url, init) => app.request(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: res.isError === true, text, data: res.isError ? undefined : JSON.parse(text) };
}

describe('MCP endpoint', () => {
  it('exposes the 14 agentteams tools', async () => {
    const client = await connect(team.keys.ronit);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'assign_task', 'claim_files', 'claim_task', 'complete_task', 'create_task', 'get_activity', 'get_changes',
      'list_tasks', 'read_inbox', 'release_files', 'send_message', 'team_status', 'update_task', 'who_owns',
    ]);
  });

  it('runs an orchestrated task end to end', async () => {
    const ronit = await connect(team.keys.ronit);
    const ash = await connect(team.keys.ash);

    expect((await call(ronit, 'create_task', { title: 'Login page', assignee: 'ash-codex' })).data).toMatchObject({ number: 1, status: 'assigned' });
    const inbox = (await call(ash, 'read_inbox')).data;
    expect(inbox).toEqual([expect.objectContaining({ kind: 'command', from: 'ronit-claude' })]);
    expect((await call(ash, 'claim_task', { task: 1 })).data.status).toBe('in_progress');
    expect((await call(ash, 'claim_files', { globs: ['src/auth/**'] })).data.granted).toBe(true);
    expect((await call(ronit, 'claim_files', { globs: ['src/auth/login.ts'] })).data).toMatchObject({ granted: false });
    expect((await call(ronit, 'who_owns', { path: 'src/auth/login.ts' })).data).toEqual([expect.objectContaining({ agent: 'ash-codex' })]);
    expect((await call(ash, 'complete_task', { task: 1, summary: 'Built /login', branch: 'at/ash-codex/1' })).data.status).toBe('done');
    expect((await call(ronit, 'read_inbox')).data).toEqual([expect.objectContaining({ body: expect.stringContaining('Task #1 done') })]);
    const status = (await call(ronit, 'team_status')).data;
    expect(status.agents.map((a: { name: string; presence: string }) => [a.name, a.presence])).toEqual([
      ['ronit-claude', 'active'], ['dylan-claude', 'active'], ['ash-codex', 'active'],
    ]);
    const types = (await call(ronit, 'get_activity', { limit: 100 })).data.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['task_created', 'task_claimed', 'files_claimed', 'task_completed']));
  });

  it('returns permission failures as tool errors, not transport errors', async () => {
    const dylan = await connect(team.keys.dylan);
    const res = await call(dylan, 'create_task', { title: 'x' });
    expect(res).toMatchObject({ isError: true, text: 'forbidden: only the orchestrator (ronit-claude) can create tasks' });
  });

  it('rejects connections without a valid key', async () => {
    await expect(connect('at_garbage')).rejects.toThrow();
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
