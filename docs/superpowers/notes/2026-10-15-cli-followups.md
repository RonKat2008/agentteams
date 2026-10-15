# Plan 2 (CLI + agent integration) — deferred follow-ups

Collected from the per-task reviews, the final whole-branch review and the fix-wave re-review.

## Delivery
- **Concurrent readers.** A `read_inbox` call or a second hook can run between the hook's peek and its consume. The consume can then return more than the 32KB cap, because only the count is limited. In the Stop hook, the consumed messages may contain no command, and they are dropped unshown. Fix: the hub accepts a max-bytes limit, or the consume returns ids and the hook re-peeks.
- **"(N more messages)" note.** The count it shows is capped at the hub's 100-message page.
- **Concurrent `readInbox` is at-least-once** (Plan 1 follow-up). It is still open.
- **Message loss on timeout.** Messages are lost if a hook times out after the hub has marked them read. Delivery is at-most-once.

## Robustness
- A wrong-shape credentials JSON gives a raw TypeError, and there is no lock on the credentials file.
- The slug regex isn't anchored to the host, and the slug comparison is case-sensitive.
- CRLF instruction files, double orphan markers, a non-atomic settings write and non-object `hooks` values are only partially handled. All of them need a file that is already malformed.
- The Codex TOML scanner falsely refuses dotted keys and `]` in quoted headers. Both fail safe.
- `log -f`:
  - The same-millisecond cursor can repeat or skip events; it should use an id cursor.
  - A transient poll error ends follow mode.
- The session-start hook runs status and ping sequentially.
- `join` saves the credential before printing, so a failed save orphans the hub-side agent.
- The hub rejects a tab or newline inside a committed file path, so the whole `recordCommit` fails for such a commit.

## Product / UX
- The MCP proxy connects to the hub once, at startup. If the hub is down when Codex starts, the session has zero tools. It should connect lazily and retry.
- `main.ts` statically imports the hub and the MCP SDK, which adds about 100ms to every hook. It should dynamically import them in `up` and `mcp`.
- Hooks embed `process.execPath`. The README documents re-running `install` after a Node change; a `doctor` command would check it.
- The API key is in `claude mcp add` argv, so it is briefly visible in `ps`. This is documented.
- A 401 from `/mcp` has no `WWW-Authenticate` header (Plan 1 follow-up). Verify manually in Claude Code.
- **Unverified:** the cwd Codex gives a stdio MCP server in the desktop app and IDE, and whether Codex honours PostToolUse `additionalContext` and the Stop `decision: block` contract. To check in a real end-to-end run.
