Source docs/demo/common.tape
Output assets/log.gif
Set Width 1480
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh team >/dev/null && cd $R/alice/shop-api && as alice && clear" Enter
Sleep 14s
Type "(START=5 $DEMO_DIR/scene.sh >/dev/null 2>&1 &) ; cd $R/alice/shop-api && clear" Enter
Sleep 300ms
Show
Sleep 500ms
Type "agentteams log -f --agent claude --limit 5" Sleep 400ms Enter
Sleep 32s
Ctrl+C
Sleep 1s
