# Plan 3 (git layer) — deferred follow-ups

- No timeout on the `mainRepoRoot` git call in the agent-hook path. A hook-wide budget would be better.
- Missing tests:
  - `:n` parse edge cases, and a 415 on `/api/join/preview`.
  - Merge commits, newline paths and submodules in the git helpers.
  - The worktree GitHub fetch path, `--base`, and the codex worktree install.
  - `done` on a local team skipping the push, and `pr` on a non-GitHub team.
- `isWorktreeOn` doesn't verify the git common dir, so a same-named branch at the same path could be reused.
- The default node+bin hook command is never run against the real `dist` in tests. The e2e uses the single-executable form.
- Paths the hub can't check (more than 1024 characters, or containing control characters) are skipped with a warning. That is fail-open by design.
- A peer-chosen branch name can only switch between the user's own local credentials for the repo.
- Some fix-wave commits carry a "Claude Sonnet 5.5" co-author trailer instead of the Opus line. History is left as-is, with no force-push.
