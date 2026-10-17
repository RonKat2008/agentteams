Source docs/demo/common.tape
Output assets/watch.gif
Set Width 1480
Set Height 760
Hide
# the prelude's tee wrapper would make stdout a pipe (snapshot mode); the dashboard needs the terminal itself
Type `source docs/demo/prelude.zsh && docs/demo/setup.sh team >/dev/null && cd $R/alice/shop-api && as alice && unfunction agentteams && clear && print "SETUP-""DONE"` Enter
Wait+Screen@600s /SETUP-DONE/
Type "(START=4 $DEMO_DIR/scene.sh >/dev/null 2>&1 &) ; clear" Enter
Sleep 500ms
Show
Sleep 500ms
Type "agentteams watch" Sleep 400ms Enter
Wait+Screen@180s /finished #1/
Sleep 5s
Type "q"
Sleep 1s
