# Sourced by the tapes: an isolated world under /tmp/agentteams-demo (never touches your real HOME).
# Every person gets their own HOME, AGENTTEAMS_HOME and git identity; `who <name>` switches.
export R=/tmp/agentteams-demo
export DEMO=${0:A:h}
[ -n "$DEMO_DIR" ] && DEMO=$DEMO_DIR
export GIT_CONFIG_GLOBAL=$R/gitconfig-alice
export PATH=$R/bin:$PATH
unset AGENTTEAMS_HUB AGENTTEAMS_HOME
who() {
  export HOME=$R/home/$1 AGENTTEAMS_HOME=$R/people/$1 GIT_CONFIG_GLOBAL=$R/home/$1/.gitconfig
  export USER=$1 GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$1@example.com GIT_COMMITTER_NAME=$1 GIT_COMMITTER_EMAIL=$1@example.com
}
who alice
