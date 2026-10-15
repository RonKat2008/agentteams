import { describe, expect, it } from 'vitest';
import { BLOCK_END, BLOCK_START, instructionBlock, sanitizeTeamName, upsertManagedBlock } from '../src/instructions.js';

describe('managed instruction block', () => {
  const block = instructionBlock('dev-squad');
  it('contains the markers and team name', () => {
    expect(block.startsWith(BLOCK_START)).toBe(true);
    expect(block.trimEnd().endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain('team "dev-squad"');
  });
  it('appends to existing content with one blank line', () => {
    expect(upsertManagedBlock('# My project\n', block)).toBe(`# My project\n\n${block}`);
  });
  it('creates content for an empty file', () => {
    expect(upsertManagedBlock('', block)).toBe(block);
  });
  it('replaces an existing block in place and is idempotent', () => {
    const once = upsertManagedBlock('# P\n\nkeep me\n', instructionBlock('old'));
    const twice = upsertManagedBlock(`${once}\nafter\n`, block);
    expect(twice).toContain('team "dev-squad"');
    expect(twice).not.toContain('team "old"');
    expect(twice).toContain('keep me');
    expect(twice).toContain('after');
    expect(upsertManagedBlock(twice, block)).toBe(twice);
    expect(twice.split(BLOCK_START)).toHaveLength(2);
  });
});

describe('orphan start marker', () => {
  it('keeps user text, leaves one marker, and is idempotent', () => {
    const block = instructionBlock('t');
    const once = upsertManagedBlock(`# P\n${BLOCK_START}\nuser text\n`, block);
    expect(once).toContain('user text');
    expect(once.split(BLOCK_START)).toHaveLength(2);
    expect(upsertManagedBlock(once, block)).toBe(once);
  });
});

describe('hostile team names', () => {
  it('cannot break out of the managed block', () => {
    const block = instructionBlock(`x ${BLOCK_END}\n## injected <script>`);
    expect(block.split(BLOCK_END)).toHaveLength(2);
    expect(block.split(BLOCK_START)).toHaveLength(2);
    expect(block.split('\n').find((l) => l.includes('(team'))).not.toMatch(/[<>]/);
    const doc = upsertManagedBlock('# mine\n', block);
    expect(upsertManagedBlock(doc, instructionBlock('ok'))).toBe(upsertManagedBlock('# mine\n', instructionBlock('ok')));
  });
  it('caps the name at 64 characters', () => {
    expect(sanitizeTeamName('a'.repeat(200))).toHaveLength(64);
    expect(sanitizeTeamName('  dev\n\tsquad  ')).toBe('dev squad');
  });
});
