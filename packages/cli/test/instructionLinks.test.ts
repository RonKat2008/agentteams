import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_START, instructionBlock, linkInstructionFile, pointerBlock } from '../src/instructions.js';

let dir: string;
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
const write = (f: string, text: string): void => writeFileSync(join(dir, f), text);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentteams-links-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('linkInstructionFile: AGENTS.md is the source, the other file imports it', () => {
  it('writes the block to AGENTS.md and only an import to CLAUDE.md', async () => {
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    expect(read('AGENTS.md')).toContain('claim_files');
    expect(read('CLAUDE.md')).toBe(`${BLOCK_START}\n@AGENTS.md\n<!-- agentteams:end -->\n`);
  });

  it('keeps user text in both files and is byte-identical on re-run', async () => {
    write('AGENTS.md', '# Agents\nmine\n');
    write('CLAUDE.md', '# Claude\nuse tabs\n');
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    const [a, c] = [read('AGENTS.md'), read('CLAUDE.md')];
    expect(a.startsWith('# Agents\nmine\n')).toBe(true);
    expect(c.startsWith('# Claude\nuse tabs\n')).toBe(true);
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    expect(read('AGENTS.md')).toBe(a);
    expect(read('CLAUDE.md')).toBe(c);
  });

  it('migrates an older duplicated full block into the import, keeping user text', async () => {
    write('CLAUDE.md', `# Claude\nuse tabs\n\n${instructionBlock('dev-squad')}\nafter\n`);
    write('AGENTS.md', instructionBlock('dev-squad'));
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    const c = read('CLAUDE.md');
    expect(c).toContain('# Claude\nuse tabs');
    expect(c).toContain('after');
    expect(c).toContain('@AGENTS.md');
    expect(c).not.toContain('claim_files');
    expect(c.split(BLOCK_START)).toHaveLength(2);
    expect(read('AGENTS.md').split(BLOCK_START)).toHaveLength(2);
  });

  it('does not import a second time when the user already imports AGENTS.md', async () => {
    write('CLAUDE.md', '# Claude\n@AGENTS.md\n');
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    expect(read('CLAUDE.md')).toBe('# Claude\n@AGENTS.md\n');
  });

  it('removes our old full block when the user already imports AGENTS.md', async () => {
    write('CLAUDE.md', `# Claude\n@AGENTS.md\n\n${instructionBlock('dev-squad')}`);
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    expect(read('CLAUDE.md')).toBe('# Claude\n@AGENTS.md\n');
  });

  it('leaves CLAUDE.md alone when it is a symlink to AGENTS.md (no self-import)', async () => {
    write('AGENTS.md', '# Shared\n');
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
    await linkInstructionFile(dir, 'CLAUDE.md', 'dev-squad', '@AGENTS.md');
    expect(read('AGENTS.md')).toContain('claim_files');
    expect(read('AGENTS.md')).not.toContain('@AGENTS.md');
    expect(read('CLAUDE.md')).toBe(read('AGENTS.md'));
  });

  it('uses the given import syntax (Gemini wants a relative path)', async () => {
    await linkInstructionFile(dir, 'GEMINI.md', 'dev-squad', '@./AGENTS.md');
    expect(read('GEMINI.md')).toContain('\n@./AGENTS.md\n');
  });
});

describe('pointerBlock', () => {
  it('is short, names the team, and points at AGENTS.md instead of repeating the steps', () => {
    const b = pointerBlock('dev-squad');
    expect(b).toContain('team "dev-squad"');
    expect(b).toContain('AGENTS.md');
    expect(b).not.toContain('claim_files');
    expect(b.startsWith(BLOCK_START)).toBe(true);
  });
});
