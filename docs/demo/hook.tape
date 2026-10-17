Source docs/demo/common.tape
Output assets/hook.gif
Set Height 360
Set Width 1480
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh hook >/dev/null && as jamie && cd $R/jamie/shop-api && clear" Enter
Sleep 22s
Show
Sleep 500ms
Type "# jamie's Claude Code tries to stop. Its Stop hook runs:" Enter
Sleep 600ms
Type `echo '{"hook_event_name":"Stop"}' | agentteams hook stop --tool claude | jq -r '.decision, .reason'` Sleep 400ms Enter
Sleep 5s
