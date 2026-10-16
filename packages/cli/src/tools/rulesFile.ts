import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BLOCK_START, instructionBlock } from '../instructions.js';
import { readTextIfExists } from './jsonConfig.js';
import type { InstallReport } from './types.js';

/** First line after the frontmatter of every rules file agentteams owns entirely. */
export const RULES_MANAGED_MARKER = '<!-- agentteams:managed -->';

/** Ours: carries the marker, or is an older install's file (frontmatter + our instruction block, no marker yet). */
const isOwned = (text: string): boolean =>
  text.includes(RULES_MANAGED_MARKER) || (text.startsWith('---\n') && text.includes(BLOCK_START));

/**
 * Writes a rules file that agentteams owns entirely (frontmatter + marker + the shared instruction block + extra text).
 * A file that exists without our marker is the user's: warned about and left untouched. Rewrites only when the
 * content differs, so re-installs are byte-identical.
 */
export async function writeOwnedRulesFile(
  repo: string,
  relPath: string,
  frontmatter: string[],
  teamName: string,
  report: InstallReport,
  extra = '',
): Promise<void> {
  const path = join(repo, relPath);
  const content = `---\n${frontmatter.join('\n')}\n---\n${RULES_MANAGED_MARKER}\n\n${instructionBlock(teamName)}${extra === '' ? '' : `\n${extra}\n`}`;
  const old = await readTextIfExists(path);
  if (old !== null && !isOwned(old)) {
    report.warnings.push(`${relPath} exists and is not managed by agentteams; left untouched`);
    return;
  }
  if (old !== content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  report.done.push(`wrote ${relPath}`);
}
