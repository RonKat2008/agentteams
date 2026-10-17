Source docs/demo/common.tape
Output "/tmp/agentteams-demo-status.gif"
Set Height 400
Set Width 1480
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh team >/dev/null && NODONE=1 START=0 PAUSE=0 docs/demo/scene.sh && cd $R/alice/shop-api && as alice && clear" Enter
Sleep 45s
Show
Type "agentteams status --agent claude" Enter
Sleep 2s
Screenshot assets/status.png
Sleep 500ms
