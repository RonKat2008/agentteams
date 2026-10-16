import { afterEach, describe, expect, it } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import type { CreateOpts } from '../src/commands/create.js';
import type { JoinOpts } from '../src/commands/join.js';
import { DEFAULT_HUB_URL } from '../src/paths.js';
import type { ToolChoice } from '../src/tui/detect.js';
import type { TuiCommands } from '../src/tui/flows.js';
import { BANNER, runTui } from '../src/tui/menu.js';
import { CancelledError, type Choice, type Prompter } from '../src/tui/prompter.js';
import { makeTestCli, type TestCli } from './helpers.js';

const CANCEL = Symbol('cancel');
type Answer = string | boolean | typeof CANCEL;

interface Scripted extends Prompter { log: string[]; asked: { message: string; choices?: Choice<string>[] }[] }

/** A Prompter that answers from a script, records everything shown, and fails on an invalid or unexpected answer. */
function scripted(answers: Answer[]): Scripted {
  const queue = [...answers];
  const log: string[] = [];
  const asked: Scripted['asked'] = [];
  const next = (message: string): Answer => {
    if (queue.length === 0) throw new Error(`unscripted prompt: ${message}`);
    const a = queue.shift()!;
    if (a === CANCEL) throw new CancelledError();
    return a;
  };
  return {
    log, asked,
    intro: (t) => log.push(`intro: ${t}`),
    outro: (t) => log.push(`outro: ${t}`),
    cancelled: () => log.push('cancel: Cancelled.'),
    select: async <T extends string>(message: string, choices: Choice<T>[]) => {
      asked.push({ message, choices });
      const a = next(message) as T;
      const hit = choices.find((c) => c.value === a);
      if (!hit || hit.disabled) throw new Error(`"${String(a)}" is not selectable for: ${message}`);
      return a;
    },
    text: async (message, opts) => {
      asked.push({ message });
      const a = String(next(message));
      const bad = opts?.validate?.(a);
      if (bad) throw new Error(`invalid scripted answer for ${message}: ${bad}`);
      return a.trim();
    },
    confirm: async (message) => { asked.push({ message }); return Boolean(next(message)); },
    box: (body, title) => log.push(`box: ${title}\n${body}`),
    info: (m) => log.push(`info: ${m}`),
    success: (m) => log.push(`success: ${m}`),
    error: (m) => log.push(`error: ${m}`),
    line: (t) => log.push(`line: ${t}`),
  };
}

interface Calls { create: [string, CreateOpts][]; join: [string, JoinOpts][]; status: unknown[]; log: unknown[]; up: unknown[] }

function fakeCommands(over: Partial<TuiCommands> = {}): { commands: TuiCommands; calls: Calls } {
  const calls: Calls = { create: [], join: [], status: [], log: [], up: [] };
  const commands: TuiCommands = {
    create: async (deps, name, opts) => {
      calls.create.push([name, opts]);
      deps.out('Created team.');
      return { teamName: name, inviteCode: 'abcd-efgh-jkmn-pqrs', inviteExpiresAt: '2026-11-01T00:00:00.000Z', hubUrl: DEFAULT_HUB_URL };
    },
    join: async (_d, code, opts) => { calls.join.push([code, opts]); },
    status: async (_d, opts) => { calls.status.push(opts); },
    log: async (_d, opts) => { calls.log.push(opts); },
    up: async (_d, opts) => { calls.up.push(opts); },
    ...over,
  };
  return { commands, calls };
}

const TOOLS: ToolChoice[] = [
  { tool: 'codex', detected: true, why: 'codex on PATH' },
  { tool: 'claude', detected: true, why: '~/.claude' },
  { tool: 'gemini', detected: false },
];

let t: TestCli;
afterEach(() => t?.cleanup());

function setup(answers: Answer[], over: { table?: Record<string, { code?: number; stdout?: string }>; commands?: Partial<TuiCommands>; hasGh?: boolean } = {}) {
  t = makeTestCli({ isTTY: true }, over.table ?? {});
  const p = scripted(answers);
  const { commands, calls } = fakeCommands(over.commands);
  const run = () => runTui(t.deps, { prompter: p, commands, detect: async () => TOOLS, hasGh: async () => over.hasGh ?? false });
  return { p, calls, run };
}

const link = async (tool: 'claude' | 'codex') => saveCredential(t.deps, {
  repoPath: t.deps.cwd, tool, hubUrl: 'http://127.0.0.1:4747', teamName: 'squad', agentName: `ada-${tool}`,
  apiKey: 'at_secret', createdAt: '2026-10-01T00:00:00.000Z',
});

describe('guided menu', () => {
  it('creates a team for the linked GitHub repo and shows the invite box', async () => {
    const { p, calls, run } = setup(
      ['create', 'squad', 'codex', 'link', 'public'],
      { table: { 'git remote get-url origin': { stdout: 'git@github.com:me/app.git\n' } } },
    );
    expect(await run()).toBe(0);
    expect(calls.create).toEqual([['squad', { agent: 'codex', hub: DEFAULT_HUB_URL, install: true }]]);
    expect(p.log[0]).toBe(`intro: ${BANNER}`);
    expect(p.log).toContain('line: Created team.');
    const box = p.log.find((l) => l.startsWith('box:'))!;
    expect(box).toContain('Invite code: abcd-efgh-jkmn-pqrs');
    expect(box).toContain(`agentteams join abcd-efgh-jkmn-pqrs --hub ${DEFAULT_HUB_URL}`);
    expect(p.log.at(-1)).toMatch(/^outro:/);
  });

  it('lists detected agents first and defaults the agent prompt accordingly', async () => {
    const { p, run } = setup(['create', 'squad', 'claude', 'local', 'local']);
    await run();
    const agentPrompt = p.asked.find((a) => a.message.startsWith('Which agent'))!;
    expect(agentPrompt.choices!.map((c) => c.value)).toEqual(['codex', 'claude', 'gemini']);
    expect(agentPrompt.choices![0]!.hint).toMatch(/detected/);
  });

  it('creates a new public GitHub repo outside a git repo when gh is available', async () => {
    const { calls, run } = setup(['create', 'squad', 'claude', 'new', 'public', 'custom', 'https://hub.example.com'], {
      table: { 'git rev-parse --show-toplevel': { code: 128 } }, hasGh: true,
    });
    expect(await run()).toBe(0);
    expect(calls.create[0]![1]).toEqual({ agent: 'claude', hub: 'https://hub.example.com', install: true, newRepo: true, visibility: 'public' });
  });

  it('joins with an invite code, using the current directory', async () => {
    const { calls, run } = setup(['join', 'ABCD-efgh-jkmn-pqrs', 'gemini', 'local', 'here']);
    expect(await run()).toBe(0);
    expect(calls.join).toEqual([['ABCD-efgh-jkmn-pqrs', { agent: 'gemini', hub: 'local', install: true, clone: false }]]);
  });

  it('turns the hosted-hub token question into a menu confirm (H3 still asked, no stdin read)', async () => {
    const answers: string[] = [];
    const join: TuiCommands['join'] = async (deps) => {
      answers.push(await deps.prompt('Send your GitHub token to hub.example.com? [y/N] '));
    };
    const { p, run } = setup(['join', 'abcd-efgh-jkmn-pqrs', 'claude', 'public', 'clone', false], { commands: { join } });
    await run();
    expect(answers).toEqual(['n']);
    expect(p.asked.at(-1)!.message).toBe('Send your GitHub token to hub.example.com?');
  });

  it('hides "link another agent" and disables status/activity without a team here', async () => {
    const { p, run } = setup(['quit']);
    expect(await run()).toBe(0);
    const menu = p.asked[0]!.choices!;
    expect(menu.map((c) => c.value)).not.toContain('link');
    expect(menu.find((c) => c.value === 'status')!.disabled).toBe(true);
    expect(p.log.at(-1)).toBe('outro: Bye.');
  });

  it('links another agent through join with the existing hub and no clone', async () => {
    const { p, calls, run } = setup(['link', 'gemini', 'abcd-efgh-jkmn-pqrs']);
    await link('codex');
    expect(await run()).toBe(0);
    const agentPrompt = p.asked.find((a) => a.message.startsWith('Which agent'))!;
    expect(agentPrompt.choices!.map((c) => c.value)).toEqual(['claude', 'gemini']);
    expect(calls.join).toEqual([['abcd-efgh-jkmn-pqrs', { agent: 'gemini', hub: 'http://127.0.0.1:4747', install: true, clone: false }]]);
    expect(p.log.join('\n')).not.toContain('at_secret');
  });

  it('runs status and activity, asking which agent when several are linked, then returns to the menu', async () => {
    const { calls, run } = setup(['status', 'claude', 'log', 'codex', 'quit']);
    await link('codex');
    await link('claude');
    expect(await run()).toBe(0);
    expect(calls.status).toEqual([{ agent: 'claude' }]);
    expect(calls.log).toEqual([{ agent: 'codex', follow: false, limit: 20 }]);
  });

  it('starts a shared hub', async () => {
    const { calls, p, run } = setup(['up', 'share']);
    expect(await run()).toBe(0);
    expect(calls.up).toEqual([{ share: true }]);
    expect(p.log.at(-1)).toBe('outro: Hub stopped.');
  });

  it('shows command errors as a message only and returns to the menu', async () => {
    const status: TuiCommands['status'] = async () => { throw new Error('hub unreachable'); };
    const { p, run } = setup(['status', 'quit'], { commands: { status } });
    await link('claude');
    expect(await run()).toBe(0);
    expect(p.log).toContain('error: hub unreachable');
    expect(p.log.at(-1)).toBe('outro: Bye.');
  });

  it('exits cleanly with "Cancelled." when a prompt is cancelled, even mid-flow', async () => {
    const { p, calls, run } = setup(['create', 'squad', CANCEL]);
    expect(await run()).toBe(0);
    expect(calls.create).toEqual([]);
    expect(p.log.at(-1)).toBe('cancel: Cancelled.');
  });

  it('exits cleanly when the token confirm inside a command is cancelled', async () => {
    const join: TuiCommands['join'] = async (deps) => { await deps.prompt('Send your GitHub token to h? [y/N] '); };
    const { p, run } = setup(['join', 'abcd-efgh-jkmn-pqrs', 'claude', 'public', 'clone', CANCEL], { commands: { join } });
    expect(await run()).toBe(0);
    expect(p.log.at(-1)).toBe('cancel: Cancelled.');
  });
});
