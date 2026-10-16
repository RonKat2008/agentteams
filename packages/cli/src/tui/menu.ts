import { loadCredentials, resolveCredentialForCwd, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { detectTools, which, type ToolChoice } from './detect.js';
import {
  createFlow, joinFlow, linkFlow, logFlow, realCommands, statusFlow, upFlow, type TuiCommands, type TuiContext,
} from './flows.js';
import { CancelledError, clackPrompter, type Choice, type Prompter } from './prompter.js';

export const BANNER = 'agentteams · one team, every coding agent';

type Action = 'create' | 'join' | 'link' | 'status' | 'log' | 'up' | 'quit';

export interface TuiOptions {
  prompter?: Prompter;
  commands?: TuiCommands;
  detect?: () => Promise<ToolChoice[]>;
  hasGh?: () => Promise<boolean>;
}

/** Create/join/up end the session once they succeed; status and activity return to the menu. */
const FLOWS: Record<Exclude<Action, 'quit'>, { run: (ctx: TuiContext) => Promise<void>; done?: string }> = {
  create: { run: createFlow, done: 'Open your agent in the repo; the team instructions are installed.' },
  join: { run: joinFlow, done: 'Done.' },
  link: { run: linkFlow, done: 'Done.' },
  status: { run: statusFlow },
  log: { run: logFlow },
  up: { run: upFlow, done: 'Hub stopped.' },
};

export function menuChoices(hasTeam: boolean): Choice<Action>[] {
  const noTeam = hasTeam ? undefined : 'no team in this repo yet';
  return [
    { value: 'create', label: 'Create a team' },
    { value: 'join', label: 'Join a team with an invite code' },
    ...(hasTeam ? [{ value: 'link' as const, label: 'Link another agent to this team' }] : []),
    { value: 'status', label: 'Team status', hint: noTeam, disabled: !hasTeam },
    { value: 'log', label: 'Activity', hint: noTeam ?? 'recent events', disabled: !hasTeam },
    { value: 'up', label: 'Start a local hub', hint: 'runs until Ctrl-C' },
    { value: 'quit', label: 'Quit' },
  ];
}

async function linkedHere(deps: CliDeps): Promise<Credential[]> {
  const cred = await resolveCredentialForCwd(deps, deps.cwd).catch(() => null);
  if (!cred) return [];
  return (await loadCredentials(deps)).filter((c) => c.repoPath === cred.repoPath);
}

/** Command output goes through the menu's rail; the hosted-hub token question (H3) becomes a menu confirm. */
function menuDeps(deps: CliDeps, p: Prompter): CliDeps {
  return {
    ...deps,
    out: p.line,
    err: p.line,
    prompt: async (question) => ((await p.confirm(question.replace(/\s*\[y\/N\]\s*$/i, ''), false)) ? 'y' : 'n'),
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Sigint { pause: () => void; resume: () => void }

async function loop(deps: CliDeps, p: Prompter, o: TuiOptions, sigint: Sigint): Promise<number> {
  const commands = o.commands ?? realCommands;
  const tools = await (o.detect ?? (() => detectTools(deps)))();
  const hasGh = await (o.hasGh ?? (async () => (await which('gh', deps)) !== null))();
  for (;;) {
    const linked = await linkedHere(deps);
    const action = await p.select('What would you like to do?', menuChoices(linked.length > 0), linked.length > 0 ? 'status' : 'create');
    if (action === 'quit') { p.outro('Bye.'); return 0; }
    const flow = FLOWS[action];
    if (action === 'up') sigint.pause(); // `up` stops the hub itself on Ctrl-C
    try {
      await flow.run({ deps: menuDeps(deps, p), p, commands, tools, hasGh, linked });
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      p.error(messageOf(e));
      continue;
    } finally {
      sigint.resume();
    }
    if (flow.done) { p.outro(flow.done); return 0; }
  }
}

/** The guided menu. Returns the process exit code; cancelling anywhere is a clean exit 0. */
export async function runTui(deps: CliDeps, o: TuiOptions = {}): Promise<number> {
  const p = o.prompter ?? clackPrompter({ color: deps.color });
  // Prompts handle Ctrl+C themselves (raw mode); this covers Ctrl+C while a command runs between prompts.
  const onSigint = () => { p.cancelled(); process.exit(0); };
  const sigint: Sigint = o.prompter
    ? { pause: () => {}, resume: () => {} }
    : { pause: () => process.off('SIGINT', onSigint), resume: () => { process.off('SIGINT', onSigint); process.on('SIGINT', onSigint); } };
  sigint.resume();
  p.intro(BANNER);
  try {
    return await loop(deps, p, o, sigint);
  } catch (e) {
    if (e instanceof CancelledError) { p.cancelled(); return 0; }
    p.error(messageOf(e));
    return 1;
  } finally {
    sigint.pause();
  }
}
