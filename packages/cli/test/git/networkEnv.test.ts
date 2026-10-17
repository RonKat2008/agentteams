import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { networkEnv } from '../../src/git/refs.js';
import { deps, git, makeWorld, type World } from './syncHelpers.js';

let world: World;
beforeEach(() => { world = makeWorld(); });
afterEach(async () => { await world.cleanup(); });

describe('network env for background git calls', () => {
  it('adds ssh BatchMode, no terminal prompt and the protocol allowlist when the user configured no ssh command', async () => {
    const env = await networkEnv(deps, world.clone('a'), {});
    expect(env).toEqual({ GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' });
  });

  it("keeps the user's core.sshCommand (GIT_SSH_COMMAND would override it)", async () => {
    const repo = world.clone('a');
    git(repo, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/work_ed25519');
    const env = await networkEnv(deps, repo, {});
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh' });
  });

  it('keeps GIT_SSH and GIT_SSH_COMMAND from the environment', async () => {
    const repo = world.clone('a');
    expect((await networkEnv(deps, repo, { GIT_SSH: 'plink' })).GIT_SSH_COMMAND).toBeUndefined();
    expect((await networkEnv(deps, repo, { GIT_SSH_COMMAND: 'ssh -i k' })).GIT_SSH_COMMAND).toBeUndefined();
  });
});
