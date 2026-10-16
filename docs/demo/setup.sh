#!/bin/zsh
# usage: setup.sh <stage>   fresh | team | scene | guard
# Builds the demo world for one recording. Needs the CLI built (pnpm -r build).
set -e
DEMO_DIR=${0:A:h}; source $DEMO_DIR/env.sh
CLI=${0:A:h:h:h}/packages/agentteams/dist/bin.js
pkill -f "bin.js up --port ${PORT:-4790}" 2>/dev/null || true; sleep 0.3
rm -rf $R; mkdir -p $R/bin $R/home/.claude $R/home/.codex $R/home/.cursor $R/people/hub
printf '#!/bin/sh\nexec node %s "$@"\n' $CLI > $R/bin/agentteams; chmod +x $R/bin/agentteams
git config --global init.defaultBranch main; git config --global user.name alice; git config --global user.email alice@example.com
(AGENTTEAMS_HOME=$R/people/hub agentteams up --port ${PORT:-4790} > $R/hub.log 2>&1 &)
for i in {1..50}; do curl -sf localhost:${PORT:-4790}/health >/dev/null && break; sleep 0.1; done
mkdir -p $R/shop-api/src/api $R/shop-api/src/auth $R/shop-api/web && cd $R/shop-api
for f in src/api/routes.ts src/api/orders.ts src/auth/session.ts src/auth/login.ts web/Checkout.tsx package.json; do echo "// $f" > $f; done
git init -q && git add -A && git commit -qm "initial shop api"
[ "$1" = fresh ] && exit 0

agentteams create shop-api --agent claude --as alice --local > $R/create.out 2>&1
INVITE=$(grep -o '[a-z0-9]\{4\}-[a-z0-9]\{4\}-[a-z0-9]\{4\}-[a-z0-9]\{4\}' -m1 $R/create.out)
echo $INVITE > $R/invite
agentteams join $INVITE --agent codex --as alice --no-clone >/dev/null 2>&1
for p in jamie:claude kai:cursor sam:gemini; do
  who ${p%%:*}; agentteams join $INVITE --agent ${p##*:} --as ${p%%:*} --no-clone >/dev/null 2>&1
done
who alice
[ "$1" = team ] && exit 0

if [ "$1" = guard ]; then
  mcp() { node $DEMO_DIR/mcp.mjs "$@" >/dev/null; }
  mcp alice claude create_task '{"title":"Rate-limit POST /login","assignee":"jamie-claude"}'
  mcp alice claude create_task '{"title":"Move sessions to signed cookies","assignee":"kai-cursor"}'
  mcp kai cursor claim_task '{"task":2}'
  mcp kai cursor claim_files '{"globs":["src/auth/session.ts","src/auth/login.ts"],"ttlMin":60}'
  mcp jamie claude claim_task '{"task":1}'
  git worktree add -q $R/jamie/shop-api -b at/jamie-claude/1
  echo "export const limit = rateLimit({ max: 5, windowMs: 60_000 });" >> $R/jamie/shop-api/src/auth/login.ts
fi

if [ "$1" = hook ]; then
  mcp() { node $DEMO_DIR/mcp.mjs "$@" >/dev/null; }
  mcp alice claude create_task '{"title":"Rate-limit POST /login","assignee":"jamie-claude"}'
  who jamie; echo '{"hook_event_name":"Stop"}' | agentteams hook stop --tool claude >/dev/null; who alice
  mcp alice claude send_message '{"to":"jamie-claude","kind":"command","body":"Before you finish #1: add a test for the 429 + Retry-After header."}'
fi
