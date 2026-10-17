# Friction E: agentteams watch (live team dashboard)

Status: done (branch feat/watch, branched from feat/team-friction at cb87113; not pushed)

Commits:
- 75449a7 feat: pure renderer for the watch dashboard
- 5570330 feat: agentteams watch, a live terminal dashboard of the team
- 89286ff feat: Watch the team live in the guided menu
- b9c8e42 perf: watch rewrites only the dashboard lines that changed
- 27cad02 fix: watch gives the agents panel more room in the wide layout
- e6b73da docs: Watch the team section and demo recording
- (this report)

Tests: `pnpm -r build && pnpm test` -> Test Files 2 failed | 96 passed | 1 skipped (99); Tests 6 failed | 1198 passed | 3 skipped (1207).
All 6 failures are 30 s timeouts in git sync tests this change does not touch (syncAdversarial x5, mcpProxy "reconnects…"
the known flake), run while the machine's load average was 100-370 from other sessions. Rerun alone at lower load:
mcpProxy passes, syncAdversarial still has 2 heavy tests timing out ("many agents with many segments…", "S5: the
round-robin offset…"). New tests: watchRender (20), watchLoop (9), watchCommand (7), tuiMenu (+1), all passing.

Layout (src/watch/, each file < 200 lines):
- text.ts: cell width (wide CJK and emoji = 2, combining marks = 0), truncation with "…", fit/pad, word wrap.
- model.ts: WatchState/Snapshot, task counts, live-task ordering, ages, last activity per agent, transport label
  (credentials stripped with the existing stripCredentials).
- panels.ts / render.ts: `renderFrame(state, {width,height,color,now})` -> exactly `height` lines of `width` cells.
  Wide (>=110 cols): agents + tasks left, activity feed right; otherwise stacked. Below 50x12 a "too small" message.
- loop.ts: polls (2 s default; backoff 2x per failure up to 60 s; error + "retrying in Ns" in the header, last data
  kept), redraws on a 400 ms tick / keys / resize, writes only changed lines inside a synchronized update; any
  exception stops the loop and restores the terminal. keys.ts parses raw input.
- terminal.ts: real screen (alt screen, hidden cursor, raw mode) and restore guards for SIGINT/SIGTERM/SIGHUP,
  uncaughtException/unhandledRejection and exit.
- data.ts: status + listTasks + activity(200) through the credential's TeamClient (parallel over http with a 10 s
  timeout, sequential for local/git), plus sync-status.json for git teams.
- commands/watch.ts: `--agent`, `--team <name>` (filters readableTeams; with several teams it shows the first and the
  header names the others), `--interval <s>` (>= 1), `--once`; non-TTY prints a snapshot (status table, task counts,
  sync line, last 15 events) and exits 0.

Notes:
- Reading the team counts as presence on every transport (hub/local authenticate and the git heartbeat), so the agent
  the dashboard reads as always shows "active" while it is open. Documented in the README rather than changed (it
  would need a read-without-heartbeat path in hub, local and git clients).
- Feed is newest first; scrolling moves toward older events. "LAST" is the agent's newest event in the last 200, else
  lastSeenAt.
- GIF: docs/demo/watch.tape (added to `pnpm demo`), recorded to assets/watch.gif (~70 s, 1.5 MB) with the existing
  /tmp/agentteams-demo world and scene.sh; it waits on screen text instead of fixed sleeps because setup took up to 6
  minutes under the machine load. Final frame checked (ffmpeg): only the alice prompt and `agentteams watch`, no
  setup text or personal names.
- TDD: text.ts helpers were written just ahead of their tests; everything else was test-first.
