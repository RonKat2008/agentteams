import { describe, expect, it } from 'vitest';
import * as core from '@agentteams/hub/core';
import { createHlc, formatHlc } from '../../src/git/hlc.js';
import {
  OP_SCHEMAS, buildRegistry, canonicalJson, captureBootstrapOp, captureOp, compareOps, mintOpId, opIdMatchesTs, rowIdSequence,
} from '../../src/git/ops.js';

const T = Date.UTC(2026, 9, 16, 12);
const KEY = 'k'.repeat(43);

describe('op ids', () => {
  it('encode the HLC time and counter, so id order follows ts order', () => {
    const tsA = formatHlc(T, 0);
    const tsB = formatHlc(T, 1);
    const tsC = formatHlc(T + 1, 0);
    const max = (1n << 64n) - 1n;
    const a = mintOpId(tsA, () => max); // largest random part
    const b = mintOpId(tsB, () => 0n); // smallest random part
    const c = mintOpId(tsC, () => 0n);
    expect(a < b && b < c).toBe(true);
    expect(opIdMatchesTs(a, tsA)).toBe(true);
    expect(opIdMatchesTs(a, tsB)).toBe(false);
    expect(opIdMatchesTs(b, tsC)).toBe(false);
    expect(opIdMatchesTs('not-a-ulid', tsA)).toBe(false);
    expect(opIdMatchesTs(a, 'garbage')).toBe(false);
    expect(() => mintOpId('garbage')).toThrow();
  });

  it('reject ids whose reserved headroom bits are set', () => {
    const ts = formatHlc(T, 0);
    const id = mintOpId(ts, () => 0n);
    // Flip bit 64 (reserved): the 13th char from the end carries bits 60..64.
    const chars = id.split('');
    chars[13] = 'G'; // 0b10000: bit 64 set, bits 60..63 clear
    expect(opIdMatchesTs(chars.join(''), ts)).toBe(false);
  });

  it('row ids are time-ordered by ms, deterministic, and bound to (agent, op id)', () => {
    const ts = formatHlc(T, 7);
    const id = mintOpId(ts);
    const take = (agent: string, opId: string, t: string) => {
      const next = rowIdSequence(agent, opId, t);
      return Array.from({ length: 5 }, () => next());
    };
    const ids = take('AGENTAAAAAAA', id, ts);
    expect(take('AGENTAAAAAAA', id, ts)).toEqual(ids); // deterministic
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((x) => x.slice(0, 10) === id.slice(0, 10))).toBe(true); // ULID time = ts ms
    const other = take('AGENTBBBBBBB', id, ts); // same op id, other agent: unrelated ids
    expect(other.some((x) => ids.includes(x))).toBe(false);
    const nextMs = take('AGENTAAAAAAA', id, formatHlc(T + 1, 0));
    expect(ids.every((x) => nextMs.every((y) => x < y))).toBe(true);
    expect(() => rowIdSequence('AGENTAAAAAAA', id, 'bad')).toThrow();
  });
});

describe('capture', () => {
  it('validates input with the service schema and stores the parsed form', () => {
    const hlc = createHlc(() => T);
    const op = captureOp(hlc, 'AGENT00000001', 'sendMessage', { to: 'Dylan-Claude', body: 'hi' });
    expect(op).toMatchObject({ v: 1, agent: 'AGENT00000001', op: 'sendMessage', input: { to: 'dylan-claude', body: 'hi', kind: 'fyi' } });
    expect(opIdMatchesTs(op.id, op.ts)).toBe(true);
    expect(() => captureOp(hlc, 'AGENT00000001', 'sendMessage', { to: 'all', body: '' })).toThrow(/invalid sendMessage input/);
    expect(() => captureOp(hlc, 'AGENT00000001', 'join' as never, {} as never)).toThrow(/not a regular op/);
  });

  it('mints the agent id for bootstrap ops from the op id', () => {
    const hlc = createHlc(() => T);
    const { agentId, op } = captureBootstrapOp(hlc, 'join', {
      teamId: 'team-1', member: 'kai', tool: 'cursor', agentName: 'kai-cursor', publicKey: KEY,
    });
    expect(agentId).toBe(op.id);
    expect(op.agent).toBe(op.id);
    expect(op.input).toMatchObject({ agentId: op.id, publicKey: KEY });
    expect(() => captureBootstrapOp(hlc, 'join', {
      teamId: 'team-1', member: 'kai', tool: 'cursor', agentName: 'kai-cursor', publicKey: 'short',
    })).toThrow(/invalid join input/);
  });

  it('orders ops by (ts, agent, id) and hashes canonically', () => {
    const ts = formatHlc(T, 0);
    expect(compareOps({ ts, agent: 'B', id: 'A' }, { ts, agent: 'A', id: 'Z' })).toBe(1);
    expect(compareOps({ ts, agent: 'A', id: 'A' }, { ts, agent: 'A', id: 'B' })).toBe(-1);
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"x":0,"y":1}]},"b":1}');
  });
});

describe('registry', () => {
  it('has a handler for every op name', () => {
    const registry = buildRegistry(core);
    expect(Object.keys(registry).sort()).toEqual(Object.keys(OP_SCHEMAS).sort());
  });
});
