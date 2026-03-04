#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read_env_file() {
  local key="$1"
  local fallback="${2:-}"
  local env_file="$ROOT_DIR/.env"
  if [[ -f "$env_file" ]]; then
    local line
    line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      echo "${line#*=}"
      return 0
    fi
  fi
  echo "$fallback"
}

env_or_file() {
  local key="$1"
  local fallback="${2:-}"
  local from_env="${!key:-}"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return 0
  fi
  read_env_file "$key" "$fallback"
}

log_info() {
  echo "[INFO] $*"
}

log_error() {
  echo "[ERRO] $*" >&2
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "Comando obrigatorio nao encontrado: $cmd"
    exit 1
  fi
}

compose() {
  docker compose "$@"
}

service_outage() {
  local service="$1"
  local seconds="$2"
  log_info "Parando servico '$service' por ${seconds}s..."
  compose stop "$service"
  sleep "$seconds"
  log_info "Subindo servico '$service' novamente..."
  compose start "$service"
  log_info "Cenario finalizado para '$service'."
}

trigger_cpu_chaos() {
  local seconds="$1"
  local intensity="$2"
  local workers="$3"

  require_cmd curl
  require_cmd jq

  local backend_port
  backend_port="$(env_or_file BACKEND_PORT 4000)"
  local base_url="http://127.0.0.1:${backend_port}/api"

  local admin_email
  admin_email="$(env_or_file DEFAULT_ADMIN_EMAIL "admin@hospital.local")"
  local admin_password
  admin_password="$(env_or_file DEFAULT_ADMIN_PASSWORD "dyantrace")"
  local simulation_key
  simulation_key="$(env_or_file SIMULATION_CONTROL_KEY "")"

  if [[ -z "$simulation_key" ]]; then
    log_error "SIMULATION_CONTROL_KEY nao configurada no .env."
    exit 1
  fi

  log_info "Autenticando no backend (${admin_email})..."
  local token
  token="$(curl -fsS -X POST "${base_url}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${admin_email}\",\"password\":\"${admin_password}\"}" | jq -r ".token // empty")"

  if [[ -z "$token" ]]; then
    log_error "Falha ao autenticar. Verifique email/senha admin."
    exit 1
  fi

  log_info "Disparando caos de CPU (duracao=${seconds}s, intensidade=${intensity}, workers=${workers})..."
  curl -fsS -X POST "${base_url}/operations/chaos/cpu-burn" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${token}" \
    -H "x-simulacao-chave: ${simulation_key}" \
    -d "{\"seconds\":${seconds},\"intensity\":${intensity},\"workers\":${workers}}" | jq .

  log_info "Comando enviado com sucesso."
}

show_usage() {
  cat <<'EOF'
Uso:
  ./scripts/cenarios-dynatrace.sh status
  ./scripts/cenarios-dynatrace.sh dev-api-off [segundos]
  ./scripts/cenarios-dynatrace.sh dev-front-off [segundos]
  ./scripts/cenarios-dynatrace.sh db-off [segundos]
  ./scripts/cenarios-dynatrace.sh infra-cpu [segundos] [intensidade] [workers]
  ./scripts/cenarios-dynatrace.sh all [segundos_indisponibilidade] [segundos_cpu]

Exemplos:
  ./scripts/cenarios-dynatrace.sh dev-api-off 180
  ./scripts/cenarios-dynatrace.sh db-off 120
  ./scripts/cenarios-dynatrace.sh infra-cpu 240 0.95 4
  ./scripts/cenarios-dynatrace.sh all 120 180
EOF
}

main() {
  require_cmd docker

  local command="${1:-}"
  case "$command" in
    status)
      compose ps
      ;;
    dev-api-off)
      local seconds="${2:-120}"
      service_outage "backend" "$seconds"
      ;;
    dev-front-off)
      local seconds="${2:-120}"
      service_outage "frontend" "$seconds"
      ;;
    db-off)
      local seconds="${2:-120}"
      service_outage "postgres" "$seconds"
      ;;
    infra-cpu)
      local seconds="${2:-180}"
      local intensity="${3:-0.95}"
      local workers="${4:-4}"
      trigger_cpu_chaos "$seconds" "$intensity" "$workers"
      ;;
    all)
      local outage_seconds="${2:-120}"
      local cpu_seconds="${3:-180}"
      service_outage "frontend" "$outage_seconds"
      service_outage "backend" "$outage_seconds"
      service_outage "postgres" "$outage_seconds"
      trigger_cpu_chaos "$cpu_seconds" "0.95" "4"
      ;;
    *)
      show_usage
      exit 1
      ;;
  esac
}

main "$@"

