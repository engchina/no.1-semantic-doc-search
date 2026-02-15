#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="/u01/aipoc/no.1-semantic-doc-search"
FRONTEND_DIR="${PROJECT_ROOT}/frontend"
SERVICE_SCRIPT="/u01/aipoc/start_semantic_doc_search_services.sh"
PORTS=(8081 5175)

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "ERROR: missing command: ${cmd}"
    exit 1
  fi
}

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti :"${port}" || true)"

  if [[ -z "${pids}" ]]; then
    log "port ${port} is already free"
    return 0
  fi

  log "stopping processes on port ${port}: ${pids//$'\n'/ }"
  kill ${pids} || true
  sleep 2

  pids="$(lsof -ti :"${port}" || true)"
  if [[ -n "${pids}" ]]; then
    log "force killing remaining processes on port ${port}: ${pids//$'\n'/ }"
    kill -9 ${pids} || true
  fi
}

main() {
  require_cmd npm
  require_cmd lsof

  [[ -d "${PROJECT_ROOT}" ]] || { log "ERROR: project dir not found: ${PROJECT_ROOT}"; exit 1; }
  [[ -d "${FRONTEND_DIR}" ]] || { log "ERROR: frontend dir not found: ${FRONTEND_DIR}"; exit 1; }
  [[ -x "${SERVICE_SCRIPT}" ]] || { log "ERROR: service script is not executable: ${SERVICE_SCRIPT}"; exit 1; }

  log "building frontend"
  npm --prefix "${FRONTEND_DIR}" run build

  for port in "${PORTS[@]}"; do
    stop_port "${port}"
  done

  log "starting semantic doc search services"
  "${SERVICE_SCRIPT}"
  log "restart flow completed"
}

main "$@"
