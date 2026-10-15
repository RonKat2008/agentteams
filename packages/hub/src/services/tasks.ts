import {
  AssignTaskInput, ClaimTaskInput, CompleteTaskInput, CreateTaskInput, ListTasksInput, UpdateTaskInput,
  type TaskView,
} from '@agentteams/shared';
import type { Selectable } from 'kysely';
import { withTx, type Actor, type HubContext } from '../context.js';
import type { TasksTable } from '../db/schema.js';
import { DomainError, parseInput } from '../errors.js';
import { logEvent } from './activity.js';
import { insertMessage } from './messages.js';
import { agentNames, findAgent, getTeamRow, requireOrchestrator } from './lookup.js';

type TaskRow = Selectable<TasksTable>;

function toView(row: TaskRow, names: Map<string, string>): TaskView {
  return {
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee_agent_id ? names.get(row.assignee_agent_id) ?? null : null,
    branch: row.branch,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getTask(ctx: HubContext, teamId: string, number: number): Promise<TaskRow> {
  const row = await ctx.db.selectFrom('tasks').selectAll()
    .where('team_id', '=', teamId).where('number', '=', number).executeTakeFirst();
  if (!row) throw new DomainError('not_found', `task #${number} not found`);
  return row;
}

async function view(ctx: HubContext, teamId: string, number: number): Promise<TaskView> {
  return toView(await getTask(ctx, teamId, number), await agentNames(ctx, teamId));
}

function assertNotDone(task: TaskRow): void {
  if (task.status === 'done') throw new DomainError('conflict', `task #${task.number} is already done`);
}

async function assertAssignee(ctx: HubContext, actor: Actor, task: TaskRow, action: string): Promise<void> {
  if (task.assignee_agent_id === actor.id) return;
  const owner = task.assignee_agent_id ? (await agentNames(ctx, actor.teamId)).get(task.assignee_agent_id) : undefined;
  throw new DomainError('forbidden', `only the assignee (${owner ?? 'nobody'}) can ${action} task #${task.number}`);
}

async function notifyAssignment(ctx: HubContext, actor: Actor, assigneeId: string, number: number, title: string) {
  if (assigneeId === actor.id) return;
  await insertMessage(ctx, {
    teamId: actor.teamId, fromId: actor.id, toId: assigneeId, kind: 'command',
    body: `Task #${number} assigned to you: ${title}. Call claim_task with task ${number} to start, and complete_task when done.`,
  });
}

export async function createTask(ctx: HubContext, actor: Actor, input: CreateTaskInput): Promise<TaskView> {
  const p = parseInput(CreateTaskInput, input);
  await requireOrchestrator(ctx, actor, 'create tasks');
  const assignee = p.assignee ? await findAgent(ctx, actor.teamId, p.assignee) : null;
  const nowIso = ctx.now().toISOString();

  const number = await withTx(ctx, async (tx) => {
    const max = await tx.db.selectFrom('tasks').select((eb) => eb.fn.max('number').as('max'))
      .where('team_id', '=', actor.teamId).executeTakeFirst();
    const n = Number(max?.max ?? 0) + 1;
    await tx.db.insertInto('tasks').values({
      id: tx.newId(), team_id: actor.teamId, number: n, title: p.title, description: p.description,
      status: assignee ? 'assigned' : 'open', assignee_agent_id: assignee?.id ?? null,
      branch: null, summary: null, created_by_agent_id: actor.id, created_at: nowIso, updated_at: nowIso,
    }).execute();
    await logEvent(tx, actor.teamId, actor.id, 'task_created', { task: n, title: p.title, assignee: assignee?.name ?? null });
    if (assignee) await notifyAssignment(tx, actor, assignee.id, n, p.title);
    return n;
  });
  return view(ctx, actor.teamId, number);
}

export async function assignTask(ctx: HubContext, actor: Actor, input: AssignTaskInput): Promise<TaskView> {
  const p = parseInput(AssignTaskInput, input);
  await requireOrchestrator(ctx, actor, 'assign tasks');
  const task = await getTask(ctx, actor.teamId, p.task);
  assertNotDone(task);
  const assignee = await findAgent(ctx, actor.teamId, p.assignee);
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('tasks')
      .set({ assignee_agent_id: assignee.id, status: 'assigned', updated_at: tx.now().toISOString() })
      .where('id', '=', task.id).execute();
    await logEvent(tx, actor.teamId, actor.id, 'task_assigned', { task: task.number, assignee: assignee.name });
    await notifyAssignment(tx, actor, assignee.id, task.number, task.title);
  });
  return view(ctx, actor.teamId, task.number);
}

export async function listTasks(ctx: HubContext, actor: Actor, input: ListTasksInput = {}): Promise<TaskView[]> {
  const p = parseInput(ListTasksInput, input);
  let query = ctx.db.selectFrom('tasks').selectAll().where('team_id', '=', actor.teamId);
  if (p.status) query = query.where('status', '=', p.status);
  if (p.assignee) query = query.where('assignee_agent_id', '=', (await findAgent(ctx, actor.teamId, p.assignee)).id);
  const rows = await query.orderBy('number').execute();
  const names = await agentNames(ctx, actor.teamId);
  return rows.map((r) => toView(r, names));
}

export async function claimTask(ctx: HubContext, actor: Actor, input: ClaimTaskInput): Promise<TaskView> {
  const p = parseInput(ClaimTaskInput, input);
  const task = await getTask(ctx, actor.teamId, p.task);
  assertNotDone(task);
  if (task.assignee_agent_id && task.assignee_agent_id !== actor.id) await assertAssignee(ctx, actor, task, 'claim');
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('tasks')
      .set({ assignee_agent_id: actor.id, status: 'in_progress', updated_at: tx.now().toISOString() })
      .where('id', '=', task.id).execute();
    await logEvent(tx, actor.teamId, actor.id, 'task_claimed', { task: task.number, title: task.title });
  });
  return view(ctx, actor.teamId, task.number);
}

export async function updateTask(ctx: HubContext, actor: Actor, input: UpdateTaskInput): Promise<TaskView> {
  const p = parseInput(UpdateTaskInput, input);
  const task = await getTask(ctx, actor.teamId, p.task);
  await assertAssignee(ctx, actor, task, 'update');
  assertNotDone(task);
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('tasks')
      .set({ status: p.status ?? task.status, updated_at: tx.now().toISOString() })
      .where('id', '=', task.id).execute();
    await logEvent(tx, actor.teamId, actor.id, 'task_updated', { task: task.number, status: p.status ?? task.status, note: p.note });
  });
  return view(ctx, actor.teamId, task.number);
}

export async function completeTask(ctx: HubContext, actor: Actor, input: CompleteTaskInput): Promise<TaskView> {
  const p = parseInput(CompleteTaskInput, input);
  const task = await getTask(ctx, actor.teamId, p.task);
  await assertAssignee(ctx, actor, task, 'complete');
  assertNotDone(task);
  const team = await getTeamRow(ctx, actor.teamId);
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('tasks')
      .set({ status: 'done', summary: p.summary, branch: p.branch, updated_at: tx.now().toISOString() })
      .where('id', '=', task.id).execute();
    await logEvent(tx, actor.teamId, actor.id, 'task_completed', { task: task.number, branch: p.branch, summary: p.summary });
    if (team.orchestrator_agent_id && team.orchestrator_agent_id !== actor.id) {
      await insertMessage(tx, {
        teamId: actor.teamId, fromId: actor.id, toId: team.orchestrator_agent_id, kind: 'fyi',
        body: `Task #${task.number} done on branch ${p.branch}: ${p.summary}`,
      });
    }
  });
  return view(ctx, actor.teamId, task.number);
}
