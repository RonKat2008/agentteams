Source docs/demo/common.tape
Output assets/tui-create.gif
Set Width 1480
Set Height 960
Hide
Type "source docs/demo/prelude.zsh && docs/demo/setup.sh fresh >/dev/null && cd $R/alice/shop-api && as alice && unfunction agentteams && clear" Enter
Sleep 3s
Show
Sleep 500ms
Type "agentteams" Sleep 300ms Enter
Sleep 1.8s
# Create a team
Enter Sleep 1s
Type "shop-api" Sleep 500ms Enter
Sleep 1.4s
# Agent: installed ones are detected and listed first
Sleep 1s Down Sleep 900ms Down Sleep 900ms Up Sleep 900ms Up Sleep 900ms Enter Sleep 1.2s
# Who will be on this team: people on other computers, through this repo's git remote (the default)
Sleep 1.4s Down Sleep 1s Up Sleep 900ms Enter
Sleep 1.4s
# Name is prefilled from $USER
Enter
Sleep 7s
