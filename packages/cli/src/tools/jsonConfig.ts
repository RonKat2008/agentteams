import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
