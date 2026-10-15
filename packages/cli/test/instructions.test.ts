import { describe, expect, it } from 'vitest';
import { BLOCK_END, BLOCK_START, instructionBlock, upsertManagedBlock } from '../src/instructions.js';

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
