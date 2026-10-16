Source docs/demo/common.tape
Output assets/log.gif
Set Width 1480
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh team >/dev/null && cd $R/shop-api && as alice && clear" Enter
Sleep 6s
Type "(START=4 $DEMO_DIR/scene.sh >/dev/null 2>&1 &) ; cd $R/shop-api && clear" Enter
Sleep 300ms
Show
Sleep 500ms
Type "agentteams log -f --agent claude --limit 5" Sleep 400ms Enter
Sleep 26s
Ctrl+C
Sleep 1s
