# Sourced by setup.sh and scene.sh. syncall: every person syncs once, so the demo is deterministic.
syncall() {
  local p me=$USER
  for p in alice jamie kai sam alice; do who $p; (cd $R/$p/shop-api && command agentteams sync >/dev/null 2>&1); done
  who $me
}
