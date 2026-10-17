import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '../src/credentials.js';
import { realExec, type CliDeps } from '../src/deps.js';
import { openTeamStore } from '../src/local/store.js';

export type GitDeps = Pick<CliDeps, 'exec'>;
export const gitDeps: GitDeps = { exec: realExec };

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

export interface TempRepo { root: string; repo: string; cleanup: () => void }

/** A real git repo with one commit, inside a temp dir (never the real HOME). */
export function makeRepo(): TempRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentteams-local-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface Seeded { alice: Credential; bob: Credential; inviteCode: string }

/** Create a team with agent "alice" and join "bob", straight through the hub services. */
export async function seedTeam(repo: string): Promise<Seeded> {
  const { ctx, core } = await openTeamStore(gitDeps, repo);
  const created = await core.createTeam(ctx, { name: 'Acme', member: 'alice', tool: 'claude', repo: { provider: 'local', defaultBranch: 'main' } });
  const joined = await core.joinTeam(ctx, { inviteCode: created.inviteCode, member: 'bob', tool: 'codex' });
  const base = { repoPath: repo, hubUrl: 'local', teamName: 'Acme', createdAt: '2026-01-01T00:00:00.000Z', transport: 'local' as const };
  return {
    alice: { ...base, tool: 'claude', agentName: created.agentName, apiKey: created.apiKey },
    bob: { ...base, tool: 'codex', agentName: joined.agentName, apiKey: joined.apiKey },
    inviteCode: created.inviteCode,
  };
}
