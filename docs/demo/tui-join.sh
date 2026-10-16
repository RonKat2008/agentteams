#!/bin/zsh
# Records the guided join: needs the invite code from a live team, so the tape is generated here.
set -e
DEMO_DIR=${0:A:h}; export PORT=4747
$DEMO_DIR/setup.sh team >/dev/null
source $DEMO_DIR/env.sh
git clone -q $R/shop-api $R/jamie/shop-api
sed "s/__INVITE__/$(cat $R/invite)/" $DEMO_DIR/tui-join.tape.in > $R/tui-join.tape
cd $DEMO_DIR/../.. && vhs $R/tui-join.tape
pkill -f "bin.js up --port 4747" || true
