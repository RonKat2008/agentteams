import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextIfExists } from '../tools/jsonConfig.js';

/** A project's test command, found from its files. `install` runs first when dependencies are not installed. */
export interface DetectedTest { test: string; install?: string; source: string }

/** What `npm init` writes as the test script: not a real test suite. */
const NPM_PLACEHOLDER = /no test specified/;

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function testScript(text: string | null): string | null {
  if (text === null) return null;
  try {
    const script = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts?.test;
    return typeof script === 'string' && script.trim() && !NPM_PLACEHOLDER.test(script) ? script : null;
  } catch {
    return null;
  }
}

async function node(dir: string): Promise<DetectedTest | null> {
  if (testScript(await readTextIfExists(join(dir, 'package.json'))) === null) return null;
  const [pm, install] = (await exists(join(dir, 'pnpm-lock.yaml'))) ? ['pnpm', 'pnpm install --frozen-lockfile']
    : (await exists(join(dir, 'yarn.lock'))) ? ['yarn', 'yarn install --frozen-lockfile']
      : (await exists(join(dir, 'package-lock.json'))) ? ['npm', 'npm ci'] : ['npm', 'npm install'];
  const installed = await exists(join(dir, 'node_modules'));
  return { test: `${pm} test`, ...(installed ? {} : { install }), source: 'package.json' };
}

async function make(dir: string): Promise<DetectedTest | null> {
  const text = await readTextIfExists(join(dir, 'Makefile'));
  return text !== null && /^test\s*:/m.test(text) ? { test: 'make test', source: 'Makefile' } : null;
}

async function pytest(dir: string): Promise<DetectedTest | null> {
  if (await exists(join(dir, 'pytest.ini'))) return { test: 'pytest', source: 'pytest.ini' };
  const configs: [string, RegExp][] = [
    ['pyproject.toml', /^\[tool\.pytest/m], ['setup.cfg', /^\[tool:pytest\]/m], ['tox.ini', /^\[pytest\]/m],
  ];
  for (const [file, section] of configs) {
    const text = await readTextIfExists(join(dir, file));
    if (text !== null && section.test(text)) return { test: 'pytest', source: file };
  }
  return null;
}

/**
 * The test command for the project in `dir`: a package.json `test` script (npm, pnpm or yarn by lockfile), a Makefile
 * `test` target, Cargo, Go, then pytest config. Null when nothing is found.
 */
export async function detectTestCommand(dir: string): Promise<DetectedTest | null> {
  const found = (await node(dir)) ?? (await make(dir));
  if (found) return found;
  if (await exists(join(dir, 'Cargo.toml'))) return { test: 'cargo test', source: 'Cargo.toml' };
  if (await exists(join(dir, 'go.mod'))) return { test: 'go test ./...', source: 'go.mod' };
  return pytest(dir);
}
