#!/bin/zsh
# Records the guided join: needs the invite code from a live team, so the tape is generated here.
set -e
DEMO_DIR=${0:A:h}
$DEMO_DIR/setup.sh created >/dev/null
source $DEMO_DIR/env.sh
sed "s/__INVITE__/$(cat $R/invite)/" $DEMO_DIR/tui-join.tape.in > $R/tui-join.tape
cd $DEMO_DIR/../.. && vhs $R/tui-join.tape
