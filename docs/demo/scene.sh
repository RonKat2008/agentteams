#!/bin/zsh
# Plays a short burst of team activity across the four clones (run after `setup.sh team`).
# Each step is followed by an explicit sync so the recording is deterministic; in real use hooks and the MCP
# server sync in the background.
DEMO_DIR=${0:A:h}; source $DEMO_DIR/env.sh; source $DEMO_DIR/sync.sh
mcp() { node $DEMO_DIR/mcp.mjs "$@" >/dev/null; }
beat() { syncall; sleep ${PAUSE:-1.2}; }
commit() { # commit <person> <task> <file> <message>
  local wt=$R/$1/shop-api
  who $1; git -C $wt checkout -q -b at/$1-$2/$3 2>/dev/null; echo "// change" >> $wt/$4; git -C $wt commit -qam "$5"; who alice
}
sleep ${START:-2}
mcp alice claude create_task '{"title":"Rate-limit POST /login","assignee":"jamie-claude"}'
mcp alice claude create_task '{"title":"Show order total on checkout","assignee":"kai-cursor"}'
mcp alice claude create_task '{"title":"Tests for the orders API","assignee":"sam-gemini"}'
beat
mcp jamie claude claim_task '{"task":1}'
mcp jamie claude claim_files '{"globs":["src/auth/**"]}'
mcp kai cursor claim_task '{"task":2}'
mcp kai cursor claim_files '{"globs":["web/Checkout.tsx"]}'
beat
mcp sam gemini send_message '{"to":"alice-claude","kind":"question","body":"Should order tests use the in-memory store?"}'
beat
mcp alice claude send_message '{"to":"sam-gemini","kind":"command","body":"Yes, in-memory. Real DB only in CI."}'
beat
[ -n "$NODONE" ] && exit 0   # the status screenshot stops with the work in flight
commit jamie claude 1 src/auth/login.ts "rate-limit login to 5/min per IP"
mcp jamie claude complete_task '{"task":1,"summary":"5 req/min per IP on POST /login, 429 with Retry-After","branch":"at/jamie-claude/1"}'
beat
