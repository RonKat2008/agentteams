# Plan 5: agentteams everywhere (more agents, one-command install, zero-setup hub)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Anyone can `npm i -g agentteams` and team up any popular coding agent (Claude Code, Codex,
Cursor, Gemini CLI, GitHub Copilot, Factory Droid, OpenCode, Windsurf/Devin, Cline, Roo) without
creating any cloud account or installing a database.

**Architecture:** A tool-adapter registry in the CLI replaces the claude/codex if-chain. Each adapter
installs MCP config + hooks + an instructions block for one agent, and owns a hook "dialect" that turns
a neutral hook outcome (context to inject / block stop) into that agent's stdout JSON. Teams default to
the public hub; `agentteams up --share` exposes a local SQLite hub through a Cloudflare quick tunnel.
The CLI ships as one bundled unscoped npm package `agentteams`.

**Tech stack:** existing pnpm TS monorepo (Node >= 22, TypeScript, vitest 5, zod 4, commander).
Bundling with tsup (esbuild). Tunnel via the `cloudflared` npm package (downloads the binary on first use).

**Spec:** `docs/superpowers/specs/2026-10-15-agentteams-design.md` plus these user rulings (2026-10-16):
- "this should also work with cursor and other big coding agents"; "make the setup easier like with npm";
  "make the readme like the opencodex readme" (lidge-jun/opencodex); "not everyone has neon";
  "i dont want people to need to install vercel or neon just to use this. needs to be seamless".

Research inputs (scratchpad, read them, do not copy them into the repo):
- `/private/tmp/claude-501/-Users-ronitkatikaneni/f7900955-73a5-4212-80f9-d1f5cf7df5a1/scratchpad/agent-integrations.md` — per-agent config paths, hook events, I/O contracts, doc URLs.
- `.../scratchpad/opencodex-readme.md` — README style reference.

## Global constraints

- Public hub URL constant: `https://agentteams-two.vercel.app`. `--hub local` (and `AGENTTEAMS_HUB=local`) means `http://127.0.0.1:4747`.
- Never touch the real `~/.codex`, `~/.claude*`, `~/.cursor`, `~/.gemini`, `~/.copilot`, `~/.factory`, `~/.config/*` in tests: every test uses a temp HOME via deps.homedir/env.
- Never call the real GitHub API, `gh`, `claude`, `cloudflared` or the network in tests (inject fakes via deps.exec / deps.fetch / injected spawners).
- API keys never written into any repo file or any agent config file. Agents reach the hub through the stdio proxy `agentteams mcp --tool <kind>` which resolves credentials at runtime; the proxy gains `--repo <abs path>` so configs that do not run in the repo cwd still resolve the right team.
- Project-level config files that embed absolute paths (node/CLI path) are added to `.git/info/exclude` (reuse the helper extracted from `install/claude.ts`).
- Every file we modify outside our own: managed-marker detection (never clobber user entries), `.bak` written once before first change (reuse `writeWithBackup` pattern from `install/codex.ts`), idempotent re-install.
- Instructions blocks use the existing `<!-- agentteams:start/end -->` managed block (`instructions.ts`). AGENTS.md is shared by codex/droid/opencode/copilot/cursor — one block per file regardless of how many tools write it.
- Stop gating must be loop-safe: honour `stop_hook_active` (claude/droid/gemini style) and `loop_count` (cursor); never block more than the existing one-command rule allows.
- A hook that cannot reach the hub prints nothing and exits 0 (existing behaviour).
- Existing Claude Code and Codex hook stdout must stay byte-identical (existing tests must pass unmodified).
- Commits: conventional (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), small, with trailers:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01P5zkbTve8aPBFWcnUdNQrj`.
- Run `pnpm build && pnpm test` at the repo root before reporting DONE.

## Review focus

1. Re-running `agentteams install` twice leaves every config file byte-identical to the first run.
2. A user's own MCP server / hook entries in a shared config file (e.g. `~/.cursor/hooks.json`, `.gemini/settings.json`) survive install untouched.
3. Malformed existing JSON config: install refuses with a clear warning and does not overwrite the file.
4. Stop hook for every dialect never blocks twice in a row for the same command (no infinite loops).
5. `npx agentteams` run from the npm cache: hooks would point at an ephemeral path — warn and recommend `npm i -g agentteams`.

---

### Task 1: Tool-adapter registry and hook dialects (core; everything else depends on it)

**Files:** create `packages/cli/src/tools/{types.ts,registry.ts,dialects.ts,jsonConfig.ts,gitExclude.ts}`; modify `packages/shared/src/schemas.ts` (ToolKind), `packages/cli/src/hooks.ts`, `packages/cli/src/commands/install.ts`, `packages/cli/src/install/claude.ts`, `packages/cli/src/install/codex.ts`, `packages/cli/src/mcpProxy.ts` + its command wiring in `main.ts`, `packages/cli/src/gitHooks.ts` (TOOL_ORDER), tests.

- [ ] `ToolKind = z.enum(['claude','codex','cursor','gemini','copilot','droid','opencode','windsurf','cline','roo','other'])`. Check every hub/CLI place that switches on ToolKind and keep behaviour for existing kinds.
- [ ] `ToolAdapter` interface: `{ kind: ToolKind; label: string /* "Cursor" */; tier: 'full'|'mcp'; install(deps, cred): Promise<InstallReport>; installForWorktree?(deps, cred, worktreePath): Promise<InstallReport>; dialect: HookDialect }`.
- [ ] Neutral hook outcome: `runHook` computes `{ type: 'none' } | { type: 'context'; event; text } | { type: 'block'; text }` and the tool's `HookDialect.render(outcome, input)` produces `{stdout, exitCode}`. Dialect also provides `readCwd(input)` (cursor sends `workspace_roots[0]`, others `cwd`) and `isStopLoop(input)` (`stop_hook_active === true` or `loop_count > 0`).
- [ ] Hook event names: CLI accepts the neutral names (`session-start|user-prompt-submit|post-tool-use|stop`); each adapter maps its native events onto them when it writes its hook config.
- [ ] `claudeDialect` and `codexDialect` reproduce today's output exactly. Register claude & codex adapters wrapping existing installers. Every other kind registers a placeholder adapter returning warning `no installer for tool "<kind>" yet` (Tasks 2-5 replace them; each later task edits only its own adapter file + one registry line).
- [ ] `runInstallers` uses the registry. Extract `addToGitExclude(deps, repoPath, relPath)` from claude.ts into `tools/gitExclude.ts`; extract a generic `upsertJsonConfig(path, mutate)` helper (parse → refuse on malformed with warning → mutate → write with `.bak` once → no-op if unchanged) into `tools/jsonConfig.ts`; migrate codex's hooks.json writing to it.
- [ ] `agentteams mcp --tool <kind> [--repo <path>]`: `--repo` overrides cwd for credential resolution.
- [ ] Tests: dialect outputs for claude/codex unchanged (existing tests), registry covers every ToolKind, placeholder warning, `--repo` resolution, jsonConfig malformed/idempotent/backup cases.

### Task 2: Cursor + Windsurf/Devin adapters

`packages/cli/src/tools/cursor.ts`, `windsurf.ts` + tests. Use the research report for exact formats.
- Cursor (tier full): project `.cursor/mcp.json` server `agentteams` → stdio `agentteams mcp --tool cursor --repo <repo>` (git-excluded); project `.cursor/hooks.json` (version 1) with `sessionStart`, `beforeSubmitPrompt` (heartbeat only, never blocks), `postToolUse`, `stop` (with `loop_limit: null` only if the format supports per-hook loop limits, otherwise rely on loop_count guard); dialect: context → `{"additional_context": text}`; block → `{"followup_message": text}`; `.cursor/rules/agentteams.mdc` with `alwaysApply: true` frontmatter + same instruction text as other blocks; also AGENTS.md block.
- Windsurf/Devin (tier mcp): write MCP to `~/.config/devin/mcp_config.json` and, if `~/.codeium/windsurf` exists, `~/.codeium/windsurf/mcp_config.json` (global, so `--repo` required); rules `.devin/rules/agentteams.md` (`trigger: always_on`) and `.windsurf/rules/agentteams.md`; report says no context hooks — tell the user messages arrive via `read_inbox` tool calls per the rules.

### Task 3: Gemini CLI + Factory Droid adapters

`tools/gemini.ts`, `tools/droid.ts` + tests.
- Gemini (full): project `.gemini/settings.json` → `mcpServers.agentteams` (stdio) and `hooks` for SessionStart / BeforeAgent / AfterTool / AfterAgent mapped to neutral events; dialect: context → `{"hookSpecificOutput":{"hookEventName":<native>,"additionalContext":text}}`; block → `{"decision":"deny","reason":text}`; GEMINI.md block. Git-exclude `.gemini/settings.json` only if we created it.
- Droid (full): `.factory/mcp.json` and Droid hooks config per report (Claude-like contract → reuse claude dialect shape with Droid event names); AGENTS.md block.

### Task 4: GitHub Copilot (CLI + VS Code) adapter

`tools/copilot.ts` + tests. Per report: Copilot CLI MCP (`~/.copilot/mcp-config.json` global with `--repo`, or project `.github/mcp.json` / `.mcp.json` — prefer project-level), hooks (sessionStart / postToolUse / agentStop; userPromptSubmitted heartbeat only), VS Code `.vscode/mcp.json` (`servers` key). Instructions in `.github/copilot-instructions.md` block + AGENTS.md. Dialect per report (`additionalContext`, `decision:"block"`).

### Task 5: OpenCode plugin + Cline + Roo + generic `other`

`tools/opencode.ts`, `tools/cline.ts`, `tools/roo.ts`, `tools/other.ts` + tests.
- OpenCode (full-ish): `opencode.json` `mcp.agentteams = {type:"local", command:[...]}`; plugin file `.opencode/plugin/agentteams.js` (ESM) that shells out to `agentteams hook <event> --tool opencode` on session start / after tool / idle and injects context with `client.session.prompt({ body: { noReply: true, parts: [...] } })`; stop gating on `session.idle` re-prompts at most once per command. AGENTS.md block.
- Cline / Roo (tier mcp): MCP config files per report (Roo `.roo/mcp.json`; Cline global settings file per report with `--repo`), rules `.clinerules/agentteams.md`, `.roo/rules/agentteams.md`.
- other: prints a copy-paste stdio MCP JSON snippet and writes AGENTS.md block.

### Task 6: Zero-setup hub defaults + `up --share`

`packages/cli/src/paths.ts`, `commands/up.ts`, hub config if needed, tests.
- `DEFAULT_HUB_URL` → public hub; add `LOCAL_HUB_URL`; `hubUrlFrom` maps `local` → local URL. `agentteams up` prints `--hub local` usage. Update existing tests that assumed the old default by passing `--hub local`/env explicitly.
- `agentteams up --share`: start the hub in hosted mode on SQLite (verify hosted mode works without DATABASE_URL; allowed host = tunnel hostname, trusted IP header = `cf-connecting-ip`), then start a Cloudflare quick tunnel via the `cloudflared` npm package (optionalDependency, lazy import; injectable spawner for tests), print `Share: agentteams join <code> --hub https://<x>.trycloudflare.com` style instructions. Clear error if cloudflared cannot be fetched.

### Task 7: One npm package `agentteams`

- New publish package `packages/agentteams` (name `agentteams`, bin `agentteams`), built with tsup bundling `@agentteams/shared|hub|cli` workspace code into `dist/`, npm deps external and listed as dependencies (better-sqlite3 + cloudflared optional). `files: ["dist","README.md","LICENSE"]`, `engines.node >=22`, MIT LICENSE at root and in package. Version 0.2.0.
- `paths.ts` cliCommand/cliArgv still resolve to the bundled bin. Warn on install when running from an npx cache path (`/_npx/`).
- Verify: `npm pack`, install the tarball into a temp prefix (`npm i -g --prefix <tmp>`), run `agentteams --help`, `agentteams up --port <p>` + `create --hub local --local --no-install` against it. Do NOT `npm publish`.

### Task 8: README rewrite (opencodex style) + docs

After tasks 1-7. Centered header, tagline, badges, `npm i -g agentteams` one-liner up top, supported-agents table (tier, what works), 60-second quickstart, how it works, `--share` / self-host (Vercel + Neon only in an Advanced <details>), CLI reference, privacy (what the public hub stores), development, license.

### Task 9: Final review, redeploy, smoke

Opus whole-branch review; fix wave; redeploy the hub (`vercel deploy --prod`, ToolKind changed); smoke the packed tarball against the live hub with fake agents in scratch HOMEs; merge PR.
