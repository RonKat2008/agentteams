Source docs/demo/common.tape
Output assets/guard.gif
Set Height 430
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh guard >/dev/null && as jamie && cd $R/jamie/shop-api && clear" Enter
Sleep 9s
Show
Sleep 500ms
Type "git diff --stat" Sleep 300ms Enter
Sleep 2s
Type `git commit -qam "rate-limit login"` Sleep 400ms Enter
Sleep 4s
Type `AGENTTEAMS_ALLOW=1 git commit -qam "rate-limit login"` Sleep 400ms Enter
Sleep 4s
