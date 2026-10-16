import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '../../src/credentials.js';
import { realExec } from '../../src/deps.js';
import { newAgentKeyPair, newTeamKey } from '../../src/git/crypto.js';
import { createHlc } from '../../src/git/hlc.js';
import { captureBootstrapOp } from '../../src/git/ops.js';
import { REPLICATED_TABLES } from '../../src/git/replay.js';
import { writeBootstrap } from '../../src/git/sync.js';
import { openGitView, type GitView } from '../../src/git/view.js';

export const deps = { exec: realExec };
export const TEAM = 'teamalpha01';

export const git = (cwd: string | undefined, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface World {
  tmp: string;
  remote: string;
  teamKey: string;
  clone(name: string): string;
  cleanup(): Promise<void>;
}

/** Temp HOME and GIT_CONFIG_GLOBAL, a bare remote; no network. Restore with cleanup(). */
export function makeWorld(): World {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-sync-')));
  const cfg = join(tmp, 'gitconfig');
  writeFileSync(cfg, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const home = join(tmp, 'home');
  mkdirSync(home);
  const backup: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' })) {
    backup[k] = process.env[k];
    process.env[k] = v;
  }
  const remote = join(tmp, 'remote.git');
  git(undefined, 'init', '--bare', '-q', remote);
  return {
    tmp, remote, teamKey: newTeamKey(),
    clone(name) {
      const dir = join(tmp, name);
      git(undefined, 'clone', '-q', remote, dir);
      return dir;
    },
    async cleanup() {
      for (const [k, v] of Object.entries(backup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

export interface Agent { cred: Credential; repo: string; name: string; id: string }

/** Creates the team (createTeam bootstrap) or joins it, writing the seq-0 segment in `repo`'s local log. */
export async function bootstrap(
  world: World, repo: string, kind: 'createTeam' | 'join', member: string, opts: { remote?: string; tool?: 'claude' | 'codex' } = {},
): Promise<Agent> {
  const tool = opts.tool ?? 'claude';
  const keys = newAgentKeyPair();
  const name = `${member}-${tool}`;
  const base = { teamId: TEAM, member, tool, agentName: name, publicKey: keys.publicKey };
  const { agentId, op } = kind === 'createTeam'
    ? captureBootstrapOp(createHlc(), 'createTeam', { ...base, name: 'alpha', repo: { provider: 'local', defaultBranch: 'main' } })
    : captureBootstrapOp(createHlc(), 'join', base);
  const cred: Credential = {
    repoPath: repo, tool, hubUrl: opts.remote ?? world.remote, teamName: 'alpha', agentName: name, apiKey: '',
    createdAt: '2026-10-16T00:00:00.000Z', transport: 'git',
    git: { teamId: TEAM, agentId, remote: opts.remote ?? world.remote, teamKey: world.teamKey, ...keys },
  };
  await writeBootstrap(deps, repo, cred, op);
  return { cred, repo, name, id: agentId };
}

export const view = (a: Agent): Promise<GitView> => openGitView(deps, a.cred);

/** Every replicated table, rows sorted; last_seen_at (presence, local by design) left out. */
export async function dump(a: Agent): Promise<string> {
  const { store } = await view(a);
  const out: Record<string, string[]> = {};
  for (const table of REPLICATED_TABLES) {
    const rows = await store.ctx.db.selectFrom(table).selectAll().execute();
    out[table] = rows.map((r) => {
      const { last_seen_at: _ignored, ...rest } = r as Record<string, unknown>;
      return JSON.stringify(rest);
    }).sort();
  }
  return JSON.stringify(out);
}
