import type { CliDeps } from '../deps.js';
import { detectTestCommand, type DetectedTest } from './detectTest.js';

/** Lines of test output shown. */
const TAIL_LINES = 40;

/**
 * What `merge` will run after merging: nothing (--no-test, or nothing detected), the user's own `--test`, or a command
 * detected from the base branch's files that the user approved (--yes or the prompt).
 */
export type TestPlan =
  | { kind: 'skip'; reason: string }
  | { kind: 'given'; cmd: string }
  | { kind: 'detected'; found: DetectedTest };

export interface TestOpts { test?: string | false; yes?: boolean }

const OPT_OUT = 'pass --test "<cmd>" to run a command of your choice, or --no-test';

/** Asks a yes/no question on a terminal; false without one. */
async function confirm(deps: CliDeps, question: string): Promise<boolean> {
  if (!deps.isTTY) return false;
  return /^\s*y(es)?\s*$/i.test(await deps.prompt(`${question} [y/N] `));
}

/**
 * Decides the tests before anything is merged. `wt` must still hold the base branch's files, so a task branch can
 * never choose the command. Returns null when the user did not approve a detected command (the reason is printed).
 */
export async function planTests(deps: CliDeps, wt: string, base: string, opts: TestOpts): Promise<TestPlan | null> {
  if (opts.test === false) return { kind: 'skip', reason: 'Skipping tests (--no-test).' };
  if (opts.test !== undefined) return { kind: 'given', cmd: opts.test };
  const found = await detectTestCommand(wt);
  if (!found) {
    return { kind: 'skip', reason: 'No test command found (package.json test script, Makefile test target, Cargo, Go or pytest); skipping tests. Pass --test "<cmd>" to run one.' };
  }
  deps.out(`Tests: ${found.test} (from ${base}'s ${found.source})${found.install ? `, after ${found.install}` : ''}`);
  if (opts.yes) return { kind: 'detected', found };
  if (!deps.isTTY) {
    deps.out(`Not merging: the merged code's tests would run on this computer. Pass --yes to run the detected command, or ${OPT_OUT}.`);
    return null;
  }
  if (await confirm(deps, `Run "${found.test}" on the merged code on this computer?`)) return { kind: 'detected', found };
  deps.out(`Not merging: tests not approved; ${OPT_OUT}.`);
  return null;
}

/** False when merged branches changed what the approved command does and the user did not approve the new one. */
async function definitionUnchanged(deps: CliDeps, wt: string, found: DetectedTest): Promise<boolean> {
  const now = await detectTestCommand(wt);
  if (now?.test === found.test && now.definition === found.definition) return true;
  deps.out(`The merged branches change the test definition in ${found.source} (what "${found.test}" runs); not running it.`);
  if (now?.definition !== undefined) deps.out(`  It now reads (teammate-written; review it): ${JSON.stringify(now.definition.slice(0, 300))}`);
  if (await confirm(deps, `Run the changed "${found.test}" anyway?`)) return true;
  deps.out(`Review the change, then ${OPT_OUT}.`);
  return false;
}

function printTail(deps: CliDeps, r: { stdout: string; stderr: string }): void {
  const text = `${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`.trimEnd();
  for (const line of text.split('\n').slice(-TAIL_LINES)) if (line) deps.out(`  ${line}`);
}

/** Runs the planned tests in the integration worktree. True when they passed or were skipped. */
export async function runTests(deps: CliDeps, wt: string, plan: TestPlan): Promise<boolean> {
  if (plan.kind === 'skip') { deps.out(plan.reason); return true; }
  if (plan.kind === 'detected' && !(await definitionUnchanged(deps, wt, plan.found))) return false;
  const steps = plan.kind === 'given' ? [plan.cmd] : [plan.found.install, plan.found.test];
  if (plan.kind === 'given') deps.out(`Tests: ${plan.cmd}`);
  for (const step of steps) {
    if (!step) continue;
    if (plan.kind === 'detected' && step === plan.found.install) deps.out(`Installing dependencies first: ${step}`);
    const r = await deps.exec('sh', ['-c', step], { cwd: wt });
    printTail(deps, r);
    if (r.code !== 0) { deps.out(`Tests failed (${step} exited ${r.code}).`); return false; }
  }
  deps.out('Tests passed.');
  return true;
}
