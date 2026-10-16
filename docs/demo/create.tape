Source docs/demo/common.tape
Output assets/create.gif
Set Height 780
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh fresh >/dev/null && cd $R/shop-api && as alice && clear" Enter
Sleep 2.5s
Show
Sleep 600ms
Type "agentteams create shop-api --agent claude --as alice" Sleep 400ms Enter
Sleep 4s
Type "# jamie, on another laptop:" Enter
Hide
Type `as jamie && print -z "agentteams join $(invite) --agent codex --as jamie --no-clone"; erase` Enter
Sleep 500ms
Show
Sleep 1s Enter
Sleep 3.5s
Type "agentteams status --agent codex" Sleep 400ms Enter
Sleep 5s
