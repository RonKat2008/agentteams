Source docs/demo/common.tape
Output assets/guard.gif
Set Height 420
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh guard >/dev/null && as jamie && cd $R/jamie/shop-api && clear" Enter
Sleep 30s
Show
Sleep 500ms
Type "# kai's Cursor claimed src/auth/login.ts on his machine. jamie syncs, then commits:" Enter
Sleep 400ms
Type "agentteams sync" Sleep 300ms Enter
Sleep 2.5s
Type `git commit -qam "rate-limit login"` Sleep 400ms Enter
Sleep 4s
Type `AGENTTEAMS_ALLOW=1 git commit -qam "rate-limit login"` Sleep 400ms Enter
Sleep 4s
