# Sourced by the tapes: an isolated world under /tmp/agentteams-demo (never touches your real HOME).
export R=/tmp/agentteams-demo
export DEMO=${0:A:h}
[ -n "$DEMO_DIR" ] && DEMO=$DEMO_DIR
export HOME=$R/home GIT_CONFIG_GLOBAL=$R/gitconfig AGENTTEAMS_HUB=http://127.0.0.1:4790
export PATH=$R/bin:$PATH
who() {
  export AGENTTEAMS_HOME=$R/people/$1
  export GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$1@example.com GIT_COMMITTER_NAME=$1 GIT_COMMITTER_EMAIL=$1@example.com
}
who alice
