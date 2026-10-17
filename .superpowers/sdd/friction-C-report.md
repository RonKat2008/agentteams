# Friction C report

Branch `worktree-agent-a2e7272a950cb2086` (from `feat/team-friction`).

## 1. Invite codes can be shown again
- `Credential.invite?: { code, expiresAt }` (credentials.json stays 0600; hub hashing unchanged).
- `create` (local and hub) stores the plaintext code; `agentteams invite rotate` replaces it; `revoke` drops it.
- `agentteams invite` (action now optional, default `show`; also `--rotate` / `--revoke`) reprints code + join command while
  unexpired. No stored code (older credentials, joiners) or expired: error pointing at `agentteams invite --rotate`.
- Create/rotate print "Copy this code now and treat it like a password ..." (`HUB_INVITE_WARNING`, one `printInvite` helper).
- TUI has no invite view; its created box now carries the warning, and the "link another agent" flow pre-fills the stored code.
- Tests: `test/invite.test.ts` (store, reprint, rotate via both forms, revoke, old credential, expired, 0600).

## 2. One source for team instructions
- Install used to write the identical block to CLAUDE.md, GEMINI.md, AGENTS.md, `.cursor/rules/agentteams.mdc`, `.github/copilot-instructions.md`.
- `linkInstructionFile` (instructions.ts): block goes to AGENTS.md; CLAUDE.md gets only `@AGENTS.md` inside our markers;
  GEMINI.md gets `@./AGENTS.md` (Gemini's import syntax wants a relative path; not verified against a live Gemini CLI).
- Cursor rule and Copilot instructions file get a short pointer block (`pointerBlock`): both tools read AGENTS.md, and neither
  has an import syntax. Windsurf/Cline/Roo write no AGENTS.md, so they keep their full owned rules file.
- Safe cases: user text outside our markers kept; old duplicated full block replaced in place (migration); idempotent;
  CLAUDE.md symlinked to AGENTS.md left alone (no self-import); user's own `@AGENTS.md` line detected (no double import, our block dropped).
- Side effect: installing Claude now also creates/updates AGENTS.md (it is the source).
- Tests: `test/instructionLinks.test.ts`, plus assertions in installClaude/cursor/gemini/copilot tests.

## 3. `.claude/settings.local.json` ignore
- Already excluded via `.git/info/exclude` by the Claude installer (and worktree installs). Chosen over `.gitignore`: per clone, covers
  linked worktrees, does not dirty the user's tracked, shared `.gitignore`. Other per-user repo files (cursor/gemini/droid/roo/opencode
  JSON, plugin) already use `excludeIfCreated`/`addToGitExclude`.
- Gaps fixed: (a) `gitPath` silently failed on git < 2.31 (`--path-format=absolute`), so nothing was excluded; now falls back and resolves
  relative to cwd. (b) A tracked settings file is not hidden by any ignore rule: install now warns with `git rm --cached`.
- Note: on this machine Claude Code puts the file in the global ignore, which can mask the problem; the new real-git tests
  (`test/claudeIgnore.test.ts`) isolate the global git config.

## 4. Default member name
- Cause: member = OS username; inside Codex `USER` can be `codex`, giving `codex-codex`.
- `pickMemberName(candidates)` (shared): slugify, skip empty/generic (root, user, admin, me, runner, ubuntu, node, agent, ...) and any tool
  name, else `me`. `resolveMemberName(deps, cwd)` (cli/repo.ts): git `user.name`, then OS username. Used by create, join (local/git/hub)
  and the TUI prompt default. `defaultMemberName` kept for hub-side use.
- Tests: `shared/test/memberName.test.ts`, `cli/test/memberName.test.ts` (each branch).

## Verification
`pnpm -r build` clean. `pnpm test`: 1094 passed, 5 failed under load (gitTeam.integration #8, mcpProxy reconnect, syncAdversarial R2/R4,
syncIntegration built-CLI budget); the 4 files pass when rerun alone (64 passed).

## Not done
- Hub-create path storing the invite is covered only through the shared code path (local create is tested end to end).
- No change to hub-side hashing, MCP tools, or schemas.
