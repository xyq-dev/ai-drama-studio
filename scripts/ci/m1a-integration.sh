#!/usr/bin/env bash
set -Eeuo pipefail

readonly PROJECT="ai-drama-studio-m1a-ci"
readonly LOG_DIR="/tmp/ai-drama-ci"
readonly PID_FILE="${LOG_DIR}/pids"
readonly COMPOSE=(docker compose -p "${PROJECT}" --env-file .env -f infra/compose.yaml)

mkdir -p "${LOG_DIR}"

cleanup() {
  set +e
  if [[ -f "${PID_FILE}" ]]; then
    while read -r pid; do
      [[ -n "${pid}" ]] && kill -- "-${pid}" 2>/dev/null
    done < "${PID_FILE}"
    rm -f "${PID_FILE}"
  fi
  if [[ -f .env ]]; then
    "${COMPOSE[@]}" logs --no-color > "${LOG_DIR}/compose.log" 2>&1
    "${COMPOSE[@]}" down --remove-orphans
  fi
}

if [[ "${1:-}" == "cleanup" ]]; then
  cleanup
  exit 0
fi
trap cleanup EXIT

cp .env.example .env
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up -d

wait_for_container() {
  local service="$1" expected="$2" container status
  container="$("${COMPOSE[@]}" ps -q "${service}")"
  for _ in {1..60}; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container}")"
    [[ "${status}" == "${expected}" ]] && return 0
    sleep 2
  done
  echo "${service} did not reach ${expected}" >&2
  return 1
}

wait_for_container postgres healthy
wait_for_container redis healthy
wait_for_container minio healthy

init_container="$("${COMPOSE[@]}" ps -a -q minio-init)"
[[ "$(docker inspect --format '{{.State.ExitCode}}' "${init_container}")" == "0" ]]
"${COMPOSE[@]}" run --rm --no-deps minio-init ls "local/${S3_BUCKET:-ai-drama-dev}" >/dev/null

set -a
# This file is copied verbatim from the repository's development-only example.
source .env
set +a

start_service() {
  local name="$1"
  shift
  setsid "$@" > "${LOG_DIR}/${name}.log" 2>&1 &
  echo "$!" >> "${PID_FILE}"
}

: > "${PID_FILE}"
start_service api pnpm --filter @ai-drama/api start
start_service worker pnpm --filter @ai-drama/worker start
start_service comfyui-adapter pnpm --filter @ai-drama/comfyui-adapter start
start_service media-worker python -m media_worker
start_service web pnpm --filter @ai-drama/web start

wait_for_http() {
  local url="$1" expected="$2" body_file="${3:-}"
  local code
  for _ in {1..60}; do
    code="$(curl --silent --show-error --output "${body_file:-/dev/null}" --write-out '%{http_code}' "${url}" || true)"
    [[ "${code}" == "${expected}" ]] && return 0
    sleep 2
  done
  echo "${url} did not return HTTP ${expected}" >&2
  return 1
}

assert_ready_dependencies() {
  local body="$1"
  python - "${body}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as response:
    dependencies = json.load(response)["dependencies"]
for name in ("postgres", "redis", "objectStorage"):
    assert dependencies[name]["status"] == "ok", (name, dependencies[name])
PY
}

wait_for_http http://127.0.0.1:3001/api/v1/health/live 200
wait_for_http http://127.0.0.1:3001/api/v1/health/ready 200 "${LOG_DIR}/api-ready.json"
assert_ready_dependencies "${LOG_DIR}/api-ready.json"
wait_for_http http://127.0.0.1:3002/health/live 200
wait_for_http http://127.0.0.1:3002/health/ready 200
wait_for_http http://127.0.0.1:3003/health/live 200
wait_for_http http://127.0.0.1:8001/health/live 200
wait_for_http http://127.0.0.1:3000/ 200 "${LOG_DIR}/web.html"
grep -Fq "AI Drama Studio" "${LOG_DIR}/web.html"

"${COMPOSE[@]}" stop redis
wait_for_http http://127.0.0.1:3001/api/v1/health/ready 503
wait_for_http http://127.0.0.1:3002/health/ready 503
wait_for_http http://127.0.0.1:3000/ 200

"${COMPOSE[@]}" start redis
wait_for_container redis healthy
wait_for_http http://127.0.0.1:3001/api/v1/health/ready 200
wait_for_http http://127.0.0.1:3002/health/ready 200
wait_for_http http://127.0.0.1:3000/ 200

"${COMPOSE[@]}" exec -T postgres psql \
  --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --set ON_ERROR_STOP=1 \
  --tuples-only --command 'SELECT 1;' | grep -Eq '^[[:space:]]*1[[:space:]]*$'

table_count="$("${COMPOSE[@]}" exec -T postgres psql \
  --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --set ON_ERROR_STOP=1 \
  --tuples-only --no-align \
  --command "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")"
[[ "${table_count}" == "0" ]] || {
  echo "Expected no business or migration tables in the public schema; found ${table_count}." >&2
  "${COMPOSE[@]}" exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
    --command "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';" >&2
  exit 1
}
