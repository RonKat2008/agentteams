import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { ToolKind } from '@agentteams/shared';

/** Filesystem probes used by detection; tests swap in a fake so the real HOME and PATH are never read. */
export interface DetectFs {
  isExecutable: (path: string) => Promise<boolean>;
  isDir: (path: string) => Promise<boolean>;
  listDir: (path: string) => Promise<string[]>;
}

export interface DetectEnv {
  env: NodeJS.ProcessEnv;
  homedir: string;
  platform?: NodeJS.Platform;
  fs?: DetectFs;
}

export interface ToolChoice { tool: ToolKind; detected: boolean; why?: string }

interface Signals { bins: string[]; dirs: (home: string, env: NodeJS.ProcessEnv) => string[]; extensions?: string[] }

const configHome = (home: string, env: NodeJS.ProcessEnv): string => env.XDG_CONFIG_HOME || join(home, '.config');
const VSCODE_EXTENSION_DIRS = ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions', '.windsurf/extensions'];

/** Cheap evidence that a tool is installed: binaries on PATH, config dirs under HOME, editor extensions. Never executed. */
const SIGNALS: Record<ToolKind, Signals> = {
  claude: { bins: ['claude'], dirs: (h) => [join(h, '.claude')] },
  codex: { bins: ['codex'], dirs: (h, e) => [e.CODEX_HOME || join(h, '.codex')] },
  cursor: { bins: ['cursor-agent', 'cursor'], dirs: (h) => [join(h, '.cursor')] },
  gemini: { bins: ['gemini'], dirs: (h) => [join(h, '.gemini')] },
  copilot: { bins: ['copilot'], dirs: (h) => [join(h, '.copilot')] },
  droid: { bins: ['droid'], dirs: (h) => [join(h, '.factory')] },
  opencode: { bins: ['opencode'], dirs: (h, e) => [join(configHome(h, e), 'opencode')] },
  windsurf: { bins: ['windsurf'], dirs: (h) => [join(h, '.codeium', 'windsurf')] },
  cline: { bins: [], dirs: () => [], extensions: ['saoudrizwan.claude-dev-'] },
  roo: { bins: [], dirs: () => [], extensions: ['rooveterinaryinc.roo-cline-'] },
  other: { bins: [], dirs: () => [] },
};

export const realDetectFs: DetectFs = {
  isExecutable: (p) => access(p, constants.X_OK).then(() => stat(p)).then((s) => s.isFile(), () => false),
  isDir: (p) => stat(p).then((s) => s.isDirectory(), () => false),
  listDir: (p) => readdir(p).catch(() => []),
};

/** which(1) without a shell: the first PATH entry holding an executable `name` (PATHEXT variants on Windows). */
export async function which(name: string, d: DetectEnv): Promise<string | null> {
  const fs = d.fs ?? realDetectFs;
  const win = (d.platform ?? process.platform) === 'win32';
  const exts = win ? (d.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  const dirs = (d.env.PATH ?? d.env.Path ?? '').split(win ? ';' : delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await fs.isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function evidence(tool: ToolKind, d: DetectEnv, extensionNames: string[]): Promise<string | undefined> {
  const fs = d.fs ?? realDetectFs;
  const sig = SIGNALS[tool];
  for (const bin of sig.bins) if (await which(bin, d)) return `${bin} on PATH`;
  for (const dir of sig.dirs(d.homedir, d.env)) if (await fs.isDir(dir)) return dir.replace(d.homedir, '~');
  const ext = sig.extensions?.find((prefix) => extensionNames.some((n) => n.startsWith(prefix)));
  return ext ? 'editor extension' : undefined;
}

async function installedExtensions(d: DetectEnv): Promise<string[]> {
  const fs = d.fs ?? realDetectFs;
  const lists = await Promise.all(VSCODE_EXTENSION_DIRS.map((rel) => fs.listDir(join(d.homedir, rel))));
  return lists.flat().map((n) => n.toLowerCase());
}

/** Every ToolKind, detected ones first (each group in ToolKind order); `other` is never "detected". */
export async function detectTools(d: DetectEnv): Promise<ToolChoice[]> {
  const extensions = await installedExtensions(d);
  const all = await Promise.all(ToolKind.options.map(async (tool): Promise<ToolChoice> => {
    const why = await evidence(tool, d, extensions);
    return why ? { tool, detected: true, why } : { tool, detected: false };
  }));
  return [...all.filter((c) => c.detected), ...all.filter((c) => !c.detected)];
}
