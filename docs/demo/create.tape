Source docs/demo/common.tape
Output assets/create.gif
Set Width 1480
Set Height 780
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh fresh >/dev/null && cd $R/alice/shop-api && as alice && clear" Enter
Sleep 3s
Show
Sleep 600ms
Type "# alice's repo has a git remote, so this makes a team shared through it" Enter
Type "agentteams create shop-api --agent claude" Sleep 400ms Enter
Sleep 5s
Type "# jamie, on his laptop (his own clone of the same repo):" Enter
Hide
Type `as jamie && cd $R/jamie/shop-api && print -z "agentteams join $(invite) --agent codex"; erase` Enter
Sleep 500ms
Show
Sleep 1s Enter
Sleep 5s
Type "agentteams status" Sleep 400ms Enter
Sleep 5s
