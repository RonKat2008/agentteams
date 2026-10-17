Source docs/demo/common.tape
Output assets/local.gif
Set Height 700
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh local >/dev/null && cd $R/alice/shop-api && as alice && clear" Enter
Sleep 2.5s
Show
Sleep 600ms
Type "# no git remote here, so the team lives on this computer, in .git/" Enter
Type "agentteams create shop-api --agent claude" Sleep 400ms Enter
Sleep 4s
Type "# a second agent in the same repo joins with the code" Enter
Hide
Type `print -z "agentteams join $(invite) --agent codex"; erase` Enter
Sleep 500ms
Show
Sleep 1s Enter
Sleep 3.5s
Type "agentteams status --agent codex" Sleep 400ms Enter
Sleep 4s
