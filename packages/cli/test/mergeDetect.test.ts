import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectTestCommand } from '../src/merge/detectTest.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'at-detect-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, text = '') => writeFileSync(join(dir, name), text);
const pkg = (scripts: Record<string, string>) => put('package.json', JSON.stringify({ name: 'x', scripts }));

describe('detectTestCommand', () => {
  it('finds nothing in an empty directory', async () => {
    expect(await detectTestCommand(dir)).toBeNull();
  });

  it('package.json test script: npm by default, with npm ci when there is a lockfile and no node_modules', async () => {
    pkg({ test: 'vitest run' });
    expect(await detectTestCommand(dir)).toEqual({ test: 'npm test', install: 'npm install --ignore-scripts', source: 'package.json', definition: 'vitest run' });
    put('package-lock.json', '{}');
    expect(await detectTestCommand(dir)).toEqual({ test: 'npm test', install: 'npm ci --ignore-scripts', source: 'package.json', definition: 'vitest run' });
    mkdirSync(join(dir, 'node_modules'));
    expect(await detectTestCommand(dir)).toEqual({ test: 'npm test', source: 'package.json', definition: 'vitest run' });
  });

  it('picks pnpm or yarn from the lockfile', async () => {
    pkg({ test: 'vitest run' });
    put('pnpm-lock.yaml');
    expect(await detectTestCommand(dir)).toEqual({ test: 'pnpm test', install: 'pnpm install --frozen-lockfile --ignore-scripts', source: 'package.json', definition: 'vitest run' });
    rmSync(join(dir, 'pnpm-lock.yaml'));
    put('yarn.lock');
    expect(await detectTestCommand(dir)).toMatchObject({ test: 'yarn test' });
  });

  it("ignores npm init's placeholder test script and a package.json without one", async () => {
    pkg({ test: 'echo "Error: no test specified" && exit 1' });
    expect(await detectTestCommand(dir)).toBeNull();
    pkg({ build: 'tsc' });
    expect(await detectTestCommand(dir)).toBeNull();
  });

  it('Makefile with a test target', async () => {
    put('Makefile', 'build:\n\tcc x.c\n\ntest: build\n\t./run-tests\n');
    expect(await detectTestCommand(dir)).toMatchObject({ test: 'make test', source: 'Makefile' });
    put('Makefile', 'build:\n\tcc x.c\n');
    expect(await detectTestCommand(dir)).toBeNull();
  });

  it('cargo, go and pytest', async () => {
    put('Cargo.toml', '[package]\nname = "x"\n');
    expect(await detectTestCommand(dir)).toEqual({ test: 'cargo test', source: 'Cargo.toml' });
    rmSync(join(dir, 'Cargo.toml'));
    put('go.mod', 'module x\n');
    expect(await detectTestCommand(dir)).toEqual({ test: 'go test ./...', source: 'go.mod' });
    rmSync(join(dir, 'go.mod'));
    put('pyproject.toml', '[project]\nname = "x"\n');
    expect(await detectTestCommand(dir)).toBeNull();
    put('pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n');
    expect(await detectTestCommand(dir)).toEqual({ test: 'pytest', source: 'pyproject.toml' });
    rmSync(join(dir, 'pyproject.toml'));
    put('pytest.ini', '[pytest]\n');
    expect(await detectTestCommand(dir)).toEqual({ test: 'pytest', source: 'pytest.ini' });
  });
});
