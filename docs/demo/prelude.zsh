# Hidden prelude typed by each tape: quiet prompt, demo env, and a tee wrapper so tapes can read the invite code.
setopt interactivecomments
export DEMO_DIR=$PWD/docs/demo FORCE_COLOR=1
source $DEMO_DIR/env.sh
as() { who $1; PROMPT="%F{magenta}$1%f %F{blue}shop-api%f %F{8}❯%f "; }
agentteams() { command agentteams "$@" 2>&1 | tee $R/last.out; }
invite() { grep -o '[a-z0-9]\{4\}-[a-z0-9]\{4\}-[a-z0-9]\{4\}-[a-z0-9]\{4\}' -m1 $R/last.out; }
unsetopt PROMPT_SP
erase() { printf '[1A[2K[1A[2K'; }
