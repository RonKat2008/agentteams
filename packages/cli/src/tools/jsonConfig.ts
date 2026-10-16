import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InstallReport } from './types.js';

export type JsonConfig = Record<string, unknown>;
export type UpsertStatus = 'created' | 'updated' | 'unchanged' | 'invalid';

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Writes `next`; if the file already existed, saves its old content to `<path>.bak` once (never overwrites a backup). */
export async function writeWithBackup(path: string, old: string | null, next: string): Promise<void> {
  if (old !== null && !existsSync(`${path}.bak`)) await writeFile(`${path}.bak`, old);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
}

/**
 * Read-modify-write a JSON object config. `mutate` must be pure (return a new object, leave user keys alone).
 * Missing/empty file starts from {}. Malformed JSON or a non-object root returns 'invalid' and writes nothing.
 * Output is `JSON.stringify(x, null, 2)\n`; identical output is not rewritten ('unchanged').
 */
export async function upsertJsonConfig(path: string, mutate: (config: JsonConfig) => JsonConfig): Promise<UpsertStatus> {
  const text = await readTextIfExists(path);
  let config: JsonConfig = {};
  if (text !== null && text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid';
      config = parsed as JsonConfig;
    } catch {
      return 'invalid';
    }
  }
  const next = `${JSON.stringify(mutate(config), null, 2)}\n`;
  if (next === text) return 'unchanged';
  await writeWithBackup(path, text, next);
  return text === null ? 'created' : 'updated';
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Thrown by a pure `mutate` when the existing config has a shape we refuse to rewrite (the file is left untouched). */
export class InvalidConfigShape extends Error {}
/** An entry named "agentteams" that is not ours (does not run our proxy): never overwritten. */
export class UserOwnedEntry extends InvalidConfigShape {}

/** Name of our MCP server entry in every config. */
export const MCP_ENTRY_NAME = 'agentteams';

/** Flattened argv of an MCP server entry: `command` may be a string (+ `args`) or an array (opencode). */
function entryArgv(entry: Record<string, unknown>): unknown[] {
  if (Array.isArray(entry.command)) return entry.command;
  return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
}

/** True iff the entry invokes our stdio proxy (`… mcp --tool <kind> …`). */
export function isManagedMcpEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const argv = entryArgv(entry);
  return argv.some((a, i) => a === 'mcp' && argv[i + 1] === '--tool');
}

/** The `--repo` a managed entry is pinned to, if any. */
export function mcpEntryRepo(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  const argv = entryArgv(entry);
  const i = argv.indexOf('--repo');
  const repo = i >= 0 ? argv[i + 1] : undefined;
  return typeof repo === 'string' ? repo : undefined;
}

/**
 * Pure: returns a copy of `cfg` with `cfg[key].agentteams = entry`, other servers untouched. Throws InvalidConfigShape
 * when `cfg[key]` is not an object, and UserOwnedEntry when an existing "agentteams" entry is not ours.
 */
export function setMcpEntry(cfg: JsonConfig, key: string, entry: unknown): JsonConfig {
  const servers = cfg[key];
  if (servers !== undefined && !isPlainObject(servers)) throw new InvalidConfigShape(`"${key}" is not an object`);
  const current = servers?.[MCP_ENTRY_NAME];
  if (current !== undefined && !isManagedMcpEntry(current)) {
    throw new UserOwnedEntry(
      `"${key}.${MCP_ENTRY_NAME}" is user-defined (it does not run agentteams); rename or delete it and re-run install`,
    );
  }
  return { ...cfg, [key]: { ...servers, [MCP_ENTRY_NAME]: entry } };
}

export type ManagedStatus = UpsertStatus | 'shape';

export const isWritten = (s: ManagedStatus): boolean => s !== 'invalid' && s !== 'shape';

/**
 * upsertJsonConfig plus the one refusal policy: malformed JSON or a shape error (InvalidConfigShape thrown by `mutate`)
 * leaves the file byte-identical, writes no backup, and pushes a warning naming `label`.
 */
export async function upsertManagedJson(
  path: string,
  label: string,
  mutate: (config: JsonConfig) => JsonConfig,
  report: InstallReport,
): Promise<ManagedStatus> {
  try {
    const status = await upsertJsonConfig(path, mutate);
    if (status === 'invalid') report.warnings.push(`${label} is not valid JSON (comments are not supported); left untouched`);
    return status;
  } catch (e) {
    if (e instanceof UserOwnedEntry) {
      report.warnings.push(`${label}: ${e.message}; left untouched`);
      return 'shape';
    }
    if (!(e instanceof InvalidConfigShape)) throw e;
    report.warnings.push(`${label} has an unexpected shape (${e.message}); left untouched`);
    return 'shape';
  }
}
