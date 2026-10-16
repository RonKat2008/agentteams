import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { instructionBlock } from '../instructions.js';
import { readTextIfExists } from './jsonConfig.js';

/**
 * Writes a rules file that agentteams owns entirely (frontmatter + the shared instruction block + extra text).
 * Rewrites only when the content differs, so re-installs are byte-identical.
 */
export async function writeOwnedRulesFile(path: string, frontmatter: string[], teamName: string, extra = ''): Promise<void> {
  const content = `---\n${frontmatter.join('\n')}\n---\n\n${instructionBlock(teamName)}${extra === '' ? '' : `\n${extra}\n`}`;
  if ((await readTextIfExists(path)) === content) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
