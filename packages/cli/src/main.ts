import { Argument, Command, CommanderError, Option } from 'commander';
import { ToolKind } from '@agentteams/shared';
import { accessGrantCommand } from './commands/access.js';
import { createCommand, type CreateOpts } from './commands/create.js';
import { installCommand } from './commands/install.js';
import { inviteCommand, type InviteAction } from './commands/invite.js';
import { joinCommand } from './commands/join.js';
import { logCommand } from './commands/log.js';
import { orchestratorCommand } from './commands/orchestrator.js';
import { statusCommand } from './commands/status.js';
import { syncCommand } from './commands/sync.js';
import { doneCommand, mergedCommand, prCommand } from './commands/finish.js';
import { worktreeCommand } from './commands/worktree.js';
import type { MergeOpts } from './commands/merge.js';
import type { RunEntryOpts } from './commands/run.js';
import type { WatchOpts } from './commands/watch.js';
import { realDeps, type CliDeps } from './deps.js';
import { runPostCommit, runPreCommit } from './gitHooks.js';
import { HOOK_EVENTS, runHook, type HookEvent } from './hooks.js';

const TOOLS = ToolKind.options;
const DEFAULT_LOG_LIMIT = 20;
const DEFAULT_WATCH_INTERVAL_SEC = 30;
const DASHBOARD_INTERVAL_SEC = 2;
const TRUST_HUB_HELP = 'send your GitHub token to a non-official hosted hub without asking (required when not interactive)';

function parsePositive(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
    return n;
  };
}

function parseSeconds(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw new Error('--interval must be a number of seconds, at least 1');
  return n;
}

function parseLimit(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('--limit must be a positive integer');
  return n;
}

const agentOpt = (def?: string) => new Option('--agent <tool>', TOOLS.join(' | ')).choices(TOOLS).default(def);

function buildProgram(deps: CliDeps, exit: { code: number }): Command {
  const program = new Command('agentteams')
    .description('Connect coding agents into a coordinated team via a hub')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.out(s.replace(/\n$/, '')),
      writeErr: (s) => deps.err(s.replace(/\n$/, '')),
    });
  const sub = (name: string) => program.command(name).exitOverride();

  sub('tui').alias('setup').description('Open the guided menu (also what plain `agentteams` does in a terminal)')
    .action(async () => {
      if (!deps.isTTY) throw new Error('the guided menu needs an interactive terminal; see agentteams --help');
      exit.code = await runTui(deps);
    });

  sub('up').description('Run a local hub (add --share to expose it over a Cloudflare tunnel)')
    .option('--port <n>', 'port (default 4747 or $AGENTTEAMS_PORT)')
    .option('--share', 'run in hosted mode behind a public Cloudflare quick tunnel')
    .action(async (o: { port?: string; share?: boolean }) => (await import('./commands/up.js')).upCommand(deps, o));
  sub('create').description('Create a team in this repo').argument('<name>')
    .addOption(agentOpt('claude')).option('--as <member>')
    .option('--hub <url>', 'use a hub server: its URL, or "local" for http://127.0.0.1:4747 (default: $AGENTTEAMS_HUB, else a team stored in this repo: shared through its git remote if it has one, otherwise on this computer)')
    .addOption(new Option('--this-computer', 'a team for agents on this computer only, even if the repo has a git remote').conflicts(['newRepo', 'hub']))
    .option('--remote <name>', 'the git remote a team is shared through (default: origin)')
    .addOption(new Option('--repo <owner/name>').conflicts('newRepo'))
    .addOption(new Option('--local', 'no GitHub link; without --hub also a team on this computer only (NOT the local hub: --hub local is)').conflicts('newRepo'))
    .addOption(new Option('--new-repo', 'create a new GitHub repo with gh and link the team to it'))
    .addOption(new Option('--private', 'new repo is private (default)').conflicts('public'))
    .addOption(new Option('--public', 'new repo is public'))
    .option('--owner <org>', 'GitHub owner/org for --new-repo').option('--no-install')
    .option('--trust-hub', TRUST_HUB_HELP)
    .action(async (name: string, o: { public?: boolean } & CreateOpts) => {
      await createCommand(deps, name, { ...o, visibility: o.public ? 'public' : 'private' });
    });
  sub('join').description('Join a team with an invite code').argument('<invite-code>')
    .addOption(agentOpt('claude')).option('--as <member>')
    .option('--hub <url>', 'hub URL, or "local" for http://127.0.0.1:4747, for hub codes (default: $AGENTTEAMS_HUB); at1- codes and this repo\'s own codes need no hub')
    .option('--no-install')
    .option('--trust-hub', TRUST_HUB_HELP)
    .option('--no-clone', 'do not clone the team repo; use the current directory')
    .option('--dir <path>', 'where to clone the team repo (default: ./<repo name>; skipped inside a clone of it)')
    .action((code: string, o) => joinCommand(deps, code, o));
  sub('install').description('(Re)configure Claude Code / Codex for this repo')
    .addOption(new Option('--agent <tool>').choices([...TOOLS, 'all']))
    .action((o) => installCommand(deps, o));
  sub('status').description('Show team status').addOption(agentOpt())
    .action((o) => statusCommand(deps, o));
  sub('watch').description('Live dashboard of the team: agents, tasks and activity (q quits; prints one snapshot when piped)')
    .addOption(agentOpt()).option('--team <name>', 'which team to show when this repo is in several')
    .option('--interval <seconds>', 'seconds between refreshes (at least 1)', parseSeconds, DASHBOARD_INTERVAL_SEC)
    .option('--once', 'print one snapshot and exit')
    .action(async (o: WatchOpts) => (await import('./commands/watch.js')).watchCommand(deps, o));
  sub('sync').description('Exchange team state with the git remote now (git teams; normally runs in the background)')
    .option('--repo <path>', 'the repo to sync (default: the current directory)')
    .addOption(new Option('--tool <tool>', TOOLS.join(' | ')).choices(TOOLS))
    .option('--quiet', 'print nothing (used by the background sync)')
    .action(async (o: { repo?: string; tool?: ToolKind; quiet?: boolean }) => { exit.code = await syncCommand(deps, o); });
  sub('log').description('Show team activity').option('-f, --follow').addOption(agentOpt())
    .option('--limit <n>', 'number of events', parseLimit, DEFAULT_LOG_LIMIT)
    .action(async (o: { follow?: boolean; limit: number; agent?: ToolKind }) => {
      const ac = new AbortController();
      const stop = () => ac.abort();
      if (o.follow) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
      try { await logCommand(deps, { agent: o.agent, follow: Boolean(o.follow), limit: o.limit, signal: ac.signal }); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    });
  sub('invite').description('Show (default), rotate or revoke the invite code')
    .addArgument(new Argument('[action]').choices(['show', 'rotate', 'revoke'])).addOption(agentOpt())
    .option('--rotate', 'issue a new invite code (same as "invite rotate")').option('--revoke', 'revoke the invite code (same as "invite revoke")')
    .action((action: InviteAction | undefined, o: { agent?: ToolKind; rotate?: boolean; revoke?: boolean }) =>
      inviteCommand(deps, o.rotate ? 'rotate' : o.revoke ? 'revoke' : action ?? 'show', o));
  sub('orchestrator').description('Make an agent the orchestrator').argument('<agent-name>').addOption(agentOpt())
    .action((target: string, o) => orchestratorCommand(deps, target, o));
  sub('worktree').description('Claim a task and give it its own git worktree and branch')
    .addArgument(new Argument('<task>', 'task number').argParser(parsePositive('task')))
    .addOption(agentOpt()).option('--base <ref>', 'branch point (default: the repo default branch)')
    .option('--remove', "remove this task's worktree instead (the branch is kept)")
    .option('--force', 'with --remove: discard uncommitted changes')
    .action((task: number, o: { agent?: ToolKind; base?: string; remove?: boolean; force?: boolean }) => worktreeCommand(deps, task, o));
  sub('run').description("Start a task's assignee (codex, cursor, claude or gemini) non-interactively in the task worktree")
    .addArgument(new Argument('[task]', 'task number').argParser(parsePositive('task')))
    .addOption(agentOpt()).option('--model <model>', "model passed to the tool's own --model flag")
    .option('--detach', 'run in the background; output goes only to the log')
    .option('--all', 'start every assigned, unfinished task whose agent is on this computer, in the background')
    .option('--watch', 'keep polling the task board and start runs for new assignments (Ctrl-C stops watching)')
    .option('--interval <seconds>', 'with --watch: seconds between polls', parsePositive('--interval'), DEFAULT_WATCH_INTERVAL_SEC)
    .addOption(new Option('--supervise').hideHelp())
    .action(async (task: number | undefined, o: RunEntryOpts) => {
      exit.code = await (await import('./commands/run.js')).runEntry(deps, task, o);
    });
  const taskArg = () => new Argument('<task>', 'task number').argParser(parsePositive('task'));
  sub('done').description('Push this task branch and mark the task done')
    .addArgument(taskArg()).addOption(agentOpt())
    .addOption(new Option('-m, --message <summary>', 'what you did').makeOptionMandatory())
    .action((task: number, o: { agent?: ToolKind; message: string }) => doneCommand(deps, task, { summary: o.message, agent: o.agent }));
  sub('pr').description('Open a GitHub pull request for a finished task')
    .addArgument(taskArg()).addOption(agentOpt())
    .action((task: number, o: { agent?: ToolKind }) => prCommand(deps, task, o));
  sub('merged').description('Record that a task branch was merged (orchestrator only)')
    .addArgument(taskArg()).addOption(agentOpt()).option('--pr <url>', 'pull request URL')
    .action((task: number, o: { agent?: ToolKind; pr?: string }) => mergedCommand(deps, task, o));
  sub('merge').description('Merge finished task branches, run the tests and land the result (orchestrator only)')
    .addOption(agentOpt()).option('--into <branch>', 'branch to merge into (default: the branch checked out in the main checkout)')
    .option('--test <cmd>', 'test command, run with sh -c (default: detected from the base branch\'s package.json, Makefile, Cargo, Go or pytest, after asking)')
    .option('--no-test', 'do not run tests')
    .option('--yes', 'run the auto-detected test command without asking (needed without a terminal)')
    .option('--no-notify', "do not ask a conflicting task's agent to rebase")
    .option('--stop-on-conflict', 'stop at the first conflict and leave it in the integration worktree')
    .option('--dry-run', 'merge and test without updating the branch or recording merges')
    .option('--push', 'push the branch after landing')
    .action(async (o: MergeOpts) => { exit.code = await (await import('./commands/merge.js')).mergeCommand(deps, o); });
  const access = sub('access').description('Manage repo access for teammates');
  access.command('grant').exitOverride().description('Invite a teammate\'s GitHub account to the repo with push access')
    .argument('<agent-or-login>').addOption(agentOpt()).option('--yes', 'skip the confirmation prompt (CI only)')
    .action((target: string, o: { yes?: boolean; agent?: ToolKind }) => accessGrantCommand(deps, target, o));
  sub('hook').description('(internal) agent hook entry point')
    .addArgument(new Argument('<event>').choices([...HOOK_EVENTS]))
    .addOption(new Option('--tool <tool>').choices(TOOLS).makeOptionMandatory())
    .option('--agentteams-managed', '(marker identifying installer-managed hooks; ignored)')
    .action(async (event: HookEvent, o: { tool: ToolKind }) => {
      const res = await runHook(event, await deps.readStdin(), o.tool, deps);
      if (res.stdout) deps.write(res.stdout);
      exit.code = 0;
    });
  sub('git-hook').description('(internal) git hook entry point')
    .addArgument(new Argument('<name>').choices(['pre-commit', 'post-commit']))
    .option('--agentteams-managed', '(marker identifying installer-managed hooks; ignored)')
    .action(async (name: 'pre-commit' | 'post-commit') => {
      exit.code = name === 'pre-commit' ? await runPreCommit(deps) : await runPostCommit(deps);
    });
  sub('mcp').description('(internal) stdio MCP proxy')
    .addOption(new Option('--tool <tool>').choices(TOOLS).makeOptionMandatory())
    .option('--repo <path>', 'resolve team credentials for this repo instead of the current directory')
    .action(async (o: { tool: ToolKind; repo?: string }) => (await import('./mcpProxy.js')).runMcpProxy(deps, o.tool, { repo: o.repo }));
  return program;
}

/** Loaded on demand so hooks, git hooks and the MCP proxy never pay for the prompt library. */
const runTui = async (deps: CliDeps): Promise<number> => (await import('./tui/menu.js')).runTui(deps);

export async function main(argv: string[], deps: CliDeps = realDeps()): Promise<number> {
  const exit = { code: 0 };
  // Bare `agentteams` in a terminal opens the menu; without a TTY it keeps printing help.
  if (argv.length <= 2 && deps.isTTY) return runTui(deps);
  try {
    await buildProgram(deps, exit).parseAsync(argv);
    return exit.code;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 1;
    deps.err(`agentteams: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
