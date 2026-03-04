#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log_info() {
  echo "[INFO] $*"
}

log_error() {
  echo "[ERRO] $*" >&2
}

read_env_file() {
  local key="$1"
  local env_file="$ROOT_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    return 1
  fi
  grep -E "^${key}=" "$env_file" | tail -n 1 | cut -d "=" -f2-
}

require_env() {
  local key="$1"
  local value
  value="$(read_env_file "$key" || true)"
  if [[ -z "$value" ]]; then
    log_error "Variavel obrigatoria ausente no .env: $key"
    return 1
  fi
  return 0
}

main() {
  if [[ ! -f ".env" ]]; then
    log_error "Arquivo .env nao encontrado."
    log_info "Crie a partir do exemplo: cp .env.example .env"
    exit 1
  fi

  command -v docker >/dev/null 2>&1 || {
    log_error "Docker nao encontrado."
    exit 1
  }

  require_env "ONEAGENT_INSTALLER_SCRIPT_URL"
  require_env "ONEAGENT_INSTALLER_DOWNLOAD_TOKEN"

  log_info "Subindo stack com perfil dynatrace..."
  docker compose --profile dynatrace up -d --build

  log_info "Status dos containers:"
  docker compose ps

  log_info "Ultimos logs do OneAgent:"
  docker compose logs --tail=80 dynatrace-oneagent || true

  log_info "Concluido. Abra o Dynatrace e confirme entidades do host/container."
}

main "$@"

