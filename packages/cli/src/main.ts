import { Argument, Command, CommanderError, Option } from 'commander';
import { ToolKind } from '@agentteams/shared';
import { createCommand } from './commands/create.js';
import { installCommand } from './commands/install.js';
import { inviteCommand } from './commands/invite.js';
import { joinCommand } from './commands/join.js';
import { logCommand } from './commands/log.js';
import { orchestratorCommand } from './commands/orchestrator.js';
import { statusCommand } from './commands/status.js';
import { upCommand } from './commands/up.js';
import { realDeps, type CliDeps } from './deps.js';
import { HOOK_EVENTS, runHook, type HookEvent } from './hooks.js';
import { runMcpProxy } from './mcpProxy.js';

const TOOLS = ToolKind.options;
const DEFAULT_LOG_LIMIT = 20;

function parseLimit(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('--limit must be a positive integer');
  return n;
}

const agentOpt = (def?: string) => new Option('--agent <tool>', 'claude | codex | other').choices(TOOLS).default(def);

function buildProgram(deps: CliDeps, exit: { code: number }): Command {
  const program = new Command('agentteams')
    .description('Connect coding agents into a coordinated team via a hub')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.out(s.replace(/\n$/, '')),
      writeErr: (s) => deps.err(s.replace(/\n$/, '')),
    });
  const sub = (name: string) => program.command(name).exitOverride();

  sub('up').description('Run a local hub').option('--port <n>', 'port (default 4747 or $AGENTTEAMS_PORT)')
    .action((o: { port?: string }) => upCommand(deps, o));
  sub('create').description('Create a team in this repo').argument('<name>')
    .addOption(agentOpt('claude')).option('--as <member>').option('--hub <url>')
    .option('--repo <owner/name>').option('--local', 'local-only team (no GitHub link)').option('--no-install')
    .action((name: string, o) => createCommand(deps, name, o));
  sub('join').description('Join a team with an invite code').argument('<invite-code>')
    .addOption(agentOpt('claude')).option('--as <member>').option('--hub <url>').option('--no-install')
    .action((code: string, o) => joinCommand(deps, code, o));
  sub('install').description('(Re)configure Claude Code / Codex for this repo')
    .addOption(new Option('--agent <tool>').choices([...TOOLS, 'all']))
    .action((o) => installCommand(deps, o));
  sub('status').description('Show team status').addOption(agentOpt())
    .action((o) => statusCommand(deps, o));
  sub('log').description('Show team activity').option('-f, --follow').addOption(agentOpt())
    .option('--limit <n>', 'number of events', parseLimit, DEFAULT_LOG_LIMIT)
    .action(async (o: { follow?: boolean; limit: number; agent?: ToolKind }) => {
      const ac = new AbortController();
      const stop = () => ac.abort();
      if (o.follow) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
      try { await logCommand(deps, { agent: o.agent, follow: Boolean(o.follow), limit: o.limit, signal: ac.signal }); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    });
  sub('invite').description('Rotate or revoke the invite code')
    .addArgument(new Argument('<action>').choices(['rotate', 'revoke'])).addOption(agentOpt())
    .action((action: 'rotate' | 'revoke', o) => inviteCommand(deps, action, o));
  sub('orchestrator').description('Make an agent the orchestrator').argument('<agent-name>').addOption(agentOpt())
    .action((target: string, o) => orchestratorCommand(deps, target, o));
  sub('hook').description('(internal) agent hook entry point')
    .addArgument(new Argument('<event>').choices([...HOOK_EVENTS]))
    .addOption(new Option('--tool <tool>').choices(TOOLS).makeOptionMandatory())
    .option('--agentteams-managed', '(marker identifying installer-managed hooks; ignored)')
    .action(async (event: HookEvent, o: { tool: ToolKind }) => {
      const res = await runHook(event, await deps.readStdin(), o.tool, deps);
      if (res.stdout) deps.write(res.stdout);
      exit.code = 0;
    });
  sub('mcp').description('(internal) stdio MCP proxy')
    .addOption(new Option('--tool <tool>').choices(TOOLS).makeOptionMandatory())
    .action((o: { tool: ToolKind }) => runMcpProxy(deps, o.tool));
  return program;
}

export async function main(argv: string[], deps: CliDeps = realDeps()): Promise<number> {
  const exit = { code: 0 };
  try {
    await buildProgram(deps, exit).parseAsync(argv);
    return exit.code;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 1;
    deps.err(`agentteams: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
