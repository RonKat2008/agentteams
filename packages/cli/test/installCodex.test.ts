import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexMcpBlock, installCodex, upsertCodexConfig, TOML_START } from '../src/install/codex.js';
import type { Credential } from '../src/credentials.js';
import { makeTestCli, type TestCli } from './helpers.js';

let t: TestCli;
let codex: string;
let cred: Credential;
const CLI = "'/usr/bin/node' '/x/agentteams/packages/cli/dist/bin.js'";
const ARGV = { command: '/usr/bin/node', args: ['/x/agentteams/packages/cli/dist/bin.js'] };

beforeEach(() => {
  t = makeTestCli();
  codex = join(t.deps.homedir, '.codex');
  mkdirSync(codex, { recursive: true });
  cred = { repoPath: t.deps.cwd, tool: 'codex', hubUrl: 'http://127.0.0.1:4747', teamName: 'dev-squad', agentName: 'ronit-codex', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => t.cleanup());

describe('codex config block', () => {
  it('renders a stdio MCP server pointing at the CLI', () => {
    expect(codexMcpBlock('/usr/bin/node', ['/x/bin.js'])).toBe([
      '# >>> agentteams (managed) >>>',
      '[mcp_servers.agentteams]',
      'command = "/usr/bin/node"',
      'args = ["/x/bin.js", "mcp", "--tool", "codex"]',
      'startup_timeout_sec = 10',
      '# <<< agentteams (managed) <<<',
      '',
    ].join('\n'));
  });
  it('appends, replaces in place, and refuses unmanaged duplicates', () => {
    const block = codexMcpBlock('/n', ['/b']);
    const once = upsertCodexConfig('model = "o3"\n\n[mcp_servers.alike]\nurl = "https://x"\n', block);
    expect(once.startsWith('model = "o3"')).toBe(true);
    expect(once.endsWith(block)).toBe(true);
    expect(upsertCodexConfig(once, block)).toBe(once);
    const replaced = upsertCodexConfig(once, codexMcpBlock('/n2', ['/b2']));
    expect(replaced).toContain('command = "/n2"');
    expect(replaced).not.toContain('command = "/n"\n');
    expect(() => upsertCodexConfig('[mcp_servers.agentteams]\nurl = "x"\n', block)).toThrow(/outside the agentteams-managed block/);
  });
});

describe('unmanaged agentteams server detection', () => {
  const block = codexMcpBlock('/n', ['/b']);
  const bad = [
    '[mcp_servers.agentteams] # x\nurl = "x"\n',
    '[ mcp_servers . agentteams ]  # x\n',
    '[mcp_servers."agentteams"]\n',
    "[mcp_servers.'agentteams']\n",
    '[mcp_servers.agentteams.env]\nA = "b"\n',
    'mcp_servers.agentteams.command = "x"\n',
    ' "mcp_servers" . \'agentteams\' . command="x"\n',
    '[mcp_servers]\nagentteams = { url = "x" }\n',
    '[ "mcp_servers" ]\n"agentteams".url = "x"\n',
    'mcp_servers = { agentteams = { url = "x" } }\n',
  ];
  it.each(bad)('refuses %j', (text) => {
    expect(() => upsertCodexConfig(text, block)).toThrow(/outside the agentteams-managed block/);
  });
  const ok = [
    '[mcp_servers.agentteams_other]\nurl = "x"\n',
    '[mcp_servers.alike]\nurl = "agentteams"\n',
    '# [mcp_servers.agentteams]\n',
    '[other]\nagentteams = 1\n',
  ];
  it.each(ok)('allows %j', (text) => {
    expect(() => upsertCodexConfig(text, block)).not.toThrow();
  });
});

describe('installCodex', () => {
  it('writes config, hooks and AGENTS.md without the key, with backups', async () => {
    writeFileSync(join(codex, 'config.toml'), 'model = "o3"\n');
    writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } }));
    const report = await installCodex(t.deps, cred, { cli: CLI, argv: ARGV });
    const config = readFileSync(join(codex, 'config.toml'), 'utf8');
    const hooks = JSON.parse(readFileSync(join(codex, 'hooks.json'), 'utf8'));
    expect(config).toContain(TOML_START);
    expect(config).not.toContain('at_SECRET');
    expect(JSON.stringify(hooks)).not.toContain('at_SECRET');
    expect(hooks.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0]!.command)).toEqual(['say hi', `${CLI} hook stop --tool codex`]);
    expect(readFileSync(join(codex, 'config.toml.bak'), 'utf8')).toBe('model = "o3"\n');
    expect(existsSync(join(codex, 'hooks.json.bak'))).toBe(true);
    expect(readFileSync(join(t.deps.cwd, 'AGENTS.md'), 'utf8')).toContain('agentteams:start');
    expect(report.warnings).toEqual([]);
    expect(report.done.join('\n')).toContain('/hooks');
  });

  it('keeps the first .bak across later content-changing runs', async () => {
    writeFileSync(join(codex, 'config.toml'), 'model = "o3"\n');
    await installCodex(t.deps, cred, { cli: CLI, argv: ARGV });
    await installCodex(t.deps, cred, { cli: CLI, argv: { command: '/other', args: ['/y'] } });
    expect(readFileSync(join(codex, 'config.toml'), 'utf8')).toContain('"/other"');
    expect(readFileSync(join(codex, 'config.toml.bak'), 'utf8')).toBe('model = "o3"\n');
  });

  it('is idempotent', async () => {
    await installCodex(t.deps, cred, { cli: CLI, argv: ARGV });
    const config1 = readFileSync(join(codex, 'config.toml'), 'utf8');
    const hooks1 = readFileSync(join(codex, 'hooks.json'), 'utf8');
    await installCodex(t.deps, cred, { cli: CLI, argv: ARGV });
    expect(readFileSync(join(codex, 'config.toml'), 'utf8')).toBe(config1);
    expect(readFileSync(join(codex, 'hooks.json'), 'utf8')).toBe(hooks1);
  });

  it('warns instead of corrupting a config with a user-owned agentteams server', async () => {
    writeFileSync(join(codex, 'config.toml'), '[mcp_servers.agentteams]\nurl = "x"\n');
    const report = await installCodex(t.deps, cred, { cli: CLI, argv: ARGV });
    expect(report.warnings.join('\n')).toContain('outside the agentteams-managed block');
    expect(readFileSync(join(codex, 'config.toml'), 'utf8')).toBe('[mcp_servers.agentteams]\nurl = "x"\n');
  });
});
