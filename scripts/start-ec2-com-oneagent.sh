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

  log_info "Subindo stack da aplicacao (sem OneAgent em container)..."
  docker compose up -d --build

  log_info "Status dos containers:"
  docker compose ps

  log_info "Se o OneAgent foi instalado no host, reiniciando app para garantir instrumentacao..."
  docker compose restart backend frontend control-panel || true

  log_info "Concluido. Confirme no Dynatrace os servicos e sessoes do frontend."
}

main "$@"
