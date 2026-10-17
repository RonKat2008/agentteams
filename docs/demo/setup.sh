#!/bin/zsh
# usage: setup.sh <stage>   fresh | local | created | team | scene | guard | hook
# Builds the demo world for one recording. Needs the CLI built (pnpm -r build). No server involved:
#   $R/remote.git   a bare repo standing in for "the GitHub repo"
#   $R/<person>/shop-api   each person's own clone, with their own HOME, AGENTTEAMS_HOME and git identity
set -e
DEMO_DIR=${0:A:h}; source $DEMO_DIR/env.sh
CLI=${0:A:h:h:h}/packages/agentteams/dist/bin.js
PEOPLE=(alice jamie kai sam)
# background syncs from earlier runs may still be writing; retry until the world is gone
for i in 1 2 3 4 5 6; do rm -rf $R 2>/dev/null && break; sleep 1; done
mkdir -p $R/bin
printf '#!/bin/sh\nexec node %s "$@"\n' $CLI > $R/bin/agentteams; chmod +x $R/bin/agentteams
for p in $PEOPLE; do
  mkdir -p $R/home/$p/.claude $R/home/$p/.codex $R/home/$p/.cursor $R/home/$p/.gemini
  who $p; git config --global init.defaultBranch main; git config --global user.name $p; git config --global user.email $p@example.com
done

# "the GitHub repo", seeded by alice
who alice
if [ "$1" = local ]; then   # a repo with no remote at all
  mkdir -p $R/alice/shop-api && git -C $R/alice/shop-api init -q
else
  git init -q --bare $R/remote.git
  git clone -q $R/remote.git $R/alice/shop-api 2>/dev/null
fi
cd $R/alice/shop-api
mkdir -p src/api src/auth web
for f in src/api/routes.ts src/api/orders.ts src/auth/session.ts src/auth/login.ts web/Checkout.tsx package.json; do echo "// $f" > $f; done
git add -A && git commit -qm "initial shop api"
if [ "$1" != local ]; then
  git push -q origin main 2>/dev/null
  for p in jamie kai sam; do who $p; git clone -q $R/remote.git $R/$p/shop-api 2>/dev/null; done
fi
who alice; cd $R/alice/shop-api
[ "$1" = fresh -o "$1" = local ] && exit 0

# alice creates the team; her second agent and the others join from their own clones
agentteams create shop-api --agent claude --as alice > $R/create.out 2>&1
INVITE=$(grep -o 'at1-[a-z0-9]*' -m1 $R/create.out)
echo $INVITE > $R/invite
[ "$1" = created ] && exit 0   # alice has made the team; nobody has joined yet
agentteams join $INVITE --agent codex --as alice --no-clone >/dev/null 2>&1
for p in jamie:claude kai:cursor sam:gemini; do
  who ${p%%:*}; cd $R/${p%%:*}/shop-api
  agentteams join $INVITE --agent ${p##*:} --as ${p%%:*} --no-clone >/dev/null 2>&1
done
source $DEMO_DIR/sync.sh; syncall; syncall
who alice; cd $R/alice/shop-api
[ "$1" = team ] && exit 0

mcp() { node $DEMO_DIR/mcp.mjs "$@" >/dev/null; }
if [ "$1" = guard ]; then
  mcp alice claude create_task '{"title":"Rate-limit POST /login","assignee":"jamie-claude"}'
  mcp alice claude create_task '{"title":"Move sessions to signed cookies","assignee":"kai-cursor"}'
  syncall
  mcp jamie claude claim_task '{"task":1}'   # jamie works on his task first
  who jamie; (cd $R/jamie/shop-api && command agentteams sync >/dev/null 2>&1); who alice
  # kai claims files on his machine and pushes; jamie has NOT synced yet (the tape does that on screen)
  mcp kai cursor claim_task '{"task":2}'
  mcp kai cursor claim_files '{"globs":["src/auth/session.ts","src/auth/login.ts"],"ttlMin":60}'
  who kai; (cd $R/kai/shop-api && command agentteams sync >/dev/null 2>&1); who alice
  cd $R/jamie/shop-api && git checkout -q -b at/jamie-claude/1
  echo "export const limit = rateLimit({ max: 5, windowMs: 60_000 });" >> src/auth/login.ts
fi

if [ "$1" = hook ]; then
  mcp alice claude create_task '{"title":"Rate-limit POST /login","assignee":"jamie-claude"}'
  mcp alice claude send_message '{"to":"jamie-claude","kind":"command","body":"Before you finish #1: add a test for the 429 + Retry-After header."}'
  syncall
fi
