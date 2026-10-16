import { mkdtempSync, realpathSync, writeFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realExec } from '../../src/deps.js';
import {
  appendSegment, fetchTeam, listAgents, pushMeta, pushOwn, readMeta, readPresence, readSegments, setPresence, writeMeta,
} from '../../src/git/refs.js';

const deps = { exec: realExec };
const TEAM = '01HZZZZZZZZZZZZZZZZZZZTEAM';
const A = '01HAAAAAAAAAAAAAAAAAAAAGNT';
const B = '01HBBBBBBBBBBBBBBBBBBBBGNT';
let tmp: string;
let remote: string;
let a: string;
let b: string;
let envBackup: Record<string, string | undefined>;

async function sh(cwd: string | undefined, ...args: string[]) {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-refs-')));
  const cfg = join(tmp, 'gitconfig');
  writeFileSync(cfg, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const home = join(tmp, 'home');
  envBackup = {};
  for (const [k, v] of Object.entries({ HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' })) {
    envBackup[k] = process.env[k]; process.env[k] = v;
  }
  remote = join(tmp, 'remote.git');
  await sh(undefined, 'init', '--bare', '-q', remote);
  a = join(tmp, 'a');
  b = join(tmp, 'b');
  for (const dir of [a, b]) {
    await sh(undefined, 'clone', '-q', remote, dir);
    writeFileSync(join(dir, 'f.txt'), 'x');
    await sh(dir, 'add', 'f.txt');
    await sh(dir, 'commit', '-q', '-m', 'init');
  }
});

afterEach(async () => {
  for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(tmp, { recursive: true, force: true });
});

const bin = (...n: number[]) => Buffer.from(n);

describe('git refs layer', () => {
  it('exchanges segments, presence and meta between two clones', async () => {
    const seg = [bin(0, 255, 10, 13, 128), bin(1, 2, 3), bin(0xff, 0xfe, 0x00)];
    await writeMeta(deps, a, TEAM, bin(9, 8, 7));
    for (let i = 0; i < 3; i++) await appendSegment(deps, a, TEAM, A, i + 1, seg[i]!);
    await setPresence(deps, a, TEAM, A, bin(5, 0, 5));
    expect(await pushMeta(deps, a, remote, TEAM)).toEqual({ ok: true });
    expect(await pushOwn(deps, a, remote, TEAM, A)).toEqual({ ok: true });

    expect(await fetchTeam(deps, b, remote, TEAM)).toEqual({ ok: true });
    expect(await listAgents(deps, b, TEAM)).toEqual([A]);
    const got = await readSegments(deps, b, TEAM, A, 0);
    expect(got.map((s) => s.seq)).toEqual([1, 2, 3]);
    got.forEach((s, i) => expect(s.data.equals(seg[i]!)).toBe(true));
    expect((await readPresence(deps, b, TEAM, A))!.equals(bin(5, 0, 5))).toBe(true);
    expect((await readMeta(deps, b, TEAM))!.equals(bin(9, 8, 7))).toBe(true);
    // creator reads its own meta from the local ref
    expect((await readMeta(deps, a, TEAM))!.equals(bin(9, 8, 7))).toBe(true);
  });

  it('lets both machines push their own refs without conflict, in any order', async () => {
    await appendSegment(deps, a, TEAM, A, 1, bin(1));
    await appendSegment(deps, b, TEAM, B, 1, bin(2));
    expect((await pushOwn(deps, a, remote, TEAM, A)).ok).toBe(true);
    expect((await pushOwn(deps, b, remote, TEAM, B)).ok).toBe(true);
    await appendSegment(deps, a, TEAM, A, 2, bin(3));
    expect((await pushOwn(deps, a, remote, TEAM, A)).ok).toBe(true); // fast-forward
    await fetchTeam(deps, a, remote, TEAM);
    await fetchTeam(deps, b, remote, TEAM);
    expect(await listAgents(deps, a, TEAM)).toEqual([A, B]);
    expect(await listAgents(deps, b, TEAM)).toEqual([A, B]);
    expect((await readSegments(deps, a, TEAM, B, 0))[0]!.data.equals(bin(2))).toBe(true);
    expect((await readSegments(deps, b, TEAM, A, 0)).map((s) => s.seq)).toEqual([1, 2]);
  });

  it('rejects non-fast-forward pushes', async () => {
    await appendSegment(deps, a, TEAM, A, 1, bin(1));
    await pushOwn(deps, a, remote, TEAM, A);
    // b forges a divergent log under the same agent id
    await appendSegment(deps, b, TEAM, A, 1, bin(9));
    const r = await pushOwn(deps, b, remote, TEAM, A);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('readSegments(fromSeq) returns segments with seq >= fromSeq only', async () => {
    for (const s of [1, 2, 3, 4]) await appendSegment(deps, a, TEAM, A, s, bin(s));
    expect((await readSegments(deps, a, TEAM, A, 3)).map((s) => s.seq)).toEqual([3, 4]);
    expect(await readSegments(deps, a, TEAM, A, 5)).toEqual([]);
    expect(await readSegments(deps, a, TEAM, B, 0)).toEqual([]);
  });

  it('keeps one commit per append and a single parent chain', async () => {
    await appendSegment(deps, a, TEAM, A, 1, bin(1));
    await appendSegment(deps, a, TEAM, A, 2, bin(2));
    await setPresence(deps, a, TEAM, A, bin(3));
    const ref = `refs/agentteams-local/${TEAM}/agents/${A}`;
    expect(await sh(a, 'rev-list', '--count', ref)).toBe('3');
    expect(await sh(a, 'ls-tree', '-r', '--name-only', ref)).toBe('ops/00000001.bin\nops/00000002.bin\npresence.bin');
    expect(await sh(a, 'log', '-1', '--format=%an <%ae>|%s', ref)).toBe('agentteams <agentteams@localhost>|agentteams');
  });

  it('leaves branches, status, HEAD and index untouched', async () => {
    const head = await sh(a, 'rev-parse', 'HEAD');
    const branches = await sh(a, 'branch', '-a');
    const indexBefore = await sh(a, 'ls-files', '-s');
    await writeMeta(deps, a, TEAM, bin(1));
    await appendSegment(deps, a, TEAM, A, 1, bin(2));
    await setPresence(deps, a, TEAM, A, bin(3));
    await pushOwn(deps, a, remote, TEAM, A);
    await fetchTeam(deps, a, remote, TEAM);
    expect(await sh(a, 'branch', '-a')).toBe(branches);
    expect(await sh(a, 'status', '--porcelain')).toBe('');
    expect(await sh(a, 'rev-parse', 'HEAD')).toBe(head);
    expect(await sh(a, 'ls-files', '-s')).toBe(indexBefore);
    expect(readdirSync(a).sort()).toEqual(['.git', 'f.txt']);
  });

  it('rejects invalid ids before touching git', async () => {
    await expect(appendSegment(deps, a, 'bad/../id', A, 1, bin(1))).rejects.toThrow(/invalid team id/);
    await expect(appendSegment(deps, a, TEAM, 'a b', 1, bin(1))).rejects.toThrow(/invalid agent id/);
    await expect(appendSegment(deps, a, TEAM, 'short', 1, bin(1))).rejects.toThrow(/invalid agent id/);
    await expect(readSegments(deps, a, TEAM, `${A}/x`, 0)).rejects.toThrow(/invalid agent id/);
    await expect(appendSegment(deps, a, TEAM, A, -1, bin(1))).rejects.toThrow(/invalid seq/);
    await expect(fetchTeam(deps, a, remote, '..')).rejects.toThrow(/invalid team id/);
  });

  it('returns ok:false instead of throwing for unreachable remotes', async () => {
    await appendSegment(deps, a, TEAM, A, 1, bin(1));
    const bad = join(tmp, 'does-not-exist.git');
    const p = await pushOwn(deps, a, bad, TEAM, A);
    expect(p.ok).toBe(false);
    expect(p.error).toBeTruthy();
    expect((await fetchTeam(deps, a, bad, TEAM)).ok).toBe(false);
  });

  it('returns ok:false when there is nothing to push, null when nothing is stored', async () => {
    expect((await pushOwn(deps, a, remote, TEAM, A)).ok).toBe(false);
    expect(await readMeta(deps, a, TEAM)).toBeNull();
    expect(await readPresence(deps, a, TEAM, A)).toBeNull();
    expect(await listAgents(deps, a, TEAM)).toEqual([]);
    expect((await fetchTeam(deps, a, remote, TEAM)).ok).toBe(true); // empty remote is fine
  });

  it('overwrites presence and meta while preserving segments', async () => {
    await appendSegment(deps, a, TEAM, A, 1, bin(1));
    await setPresence(deps, a, TEAM, A, bin(1));
    await setPresence(deps, a, TEAM, A, bin(2));
    expect((await readPresence(deps, a, TEAM, A))!.equals(bin(2))).toBe(true);
    expect((await readSegments(deps, a, TEAM, A, 0)).length).toBe(1);
    await writeMeta(deps, a, TEAM, bin(1));
    await writeMeta(deps, a, TEAM, bin(2));
    expect((await readMeta(deps, a, TEAM))!.equals(bin(2))).toBe(true);
  });
});
