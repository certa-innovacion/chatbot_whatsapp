#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

PORT="${PORT:-3000}"
ACTION="${1:-start}"
DROP_PENDING="${2:-true}"
PID_FILE="/tmp/ngrok_bot_telegram.pid"
SERVER_PID_FILE="/tmp/ngrok_bot_server.pid"
LOG_FILE="/tmp/ngrok.log"
SERVER_LOG_FILE="/tmp/ngrok_bot_server.log"

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx no esta disponible." >&2
  exit 1
fi

get_ngrok_url() {
  curl -fsS http://127.0.0.1:4040/api/tunnels \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const t=(j.tunnels||[]).find(x=>x.proto==='https');process.stdout.write(t?String(t.public_url):'')}catch{process.stdout.write('')}})"
}

is_pid_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

kill_process_tree() {
  local pid="$1"
  if [[ -z "${pid:-}" ]]; then
    return 0
  fi
  if ! is_pid_running "$pid"; then
    return 0
  fi

  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$child"
  done

  kill "$pid" >/dev/null 2>&1 || true
}

is_server_ready() {
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

is_port_open() {
  timeout 1 bash -lc "exec 3<>/dev/tcp/127.0.0.1/${PORT}" >/dev/null 2>&1
}

start_server_if_needed() {
  if is_server_ready; then
    echo "Servidor bot detectado en http://127.0.0.1:${PORT}"
    return 0
  fi

  if [[ -f "$SERVER_PID_FILE" ]]; then
    old_server_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_server_pid:-}" ]] && is_pid_running "$old_server_pid"; then
      echo "Esperando a que el servidor gestionado responda (PID ${old_server_pid})..."
      for _ in $(seq 1 60); do
        if is_server_ready; then
          echo "Servidor bot listo."
          return 0
        fi
        sleep 0.5
      done
      echo "ERROR: El servidor gestionado no respondió en /health. Revisa ${SERVER_LOG_FILE}" >&2
      exit 1
    fi
    rm -f "$SERVER_PID_FILE"
  fi

  if is_port_open; then
    echo "ERROR: El puerto ${PORT} está ocupado pero /health no responde." >&2
    echo "   Hay otro proceso usando el puerto. Libérelo y reintente." >&2
    echo "   Sugerencia: pkill -f 'src/bot/index.js' && pkill -f 'ngrok http ${PORT}'" >&2
    exit 1
  fi

  echo "Servidor no detectado. Iniciando bot en segundo plano..."
  npm run start:ngrok >"$SERVER_LOG_FILE" 2>&1 &
  server_pid=$!
  echo "$server_pid" > "$SERVER_PID_FILE"
  echo "Bot iniciado (PID ${server_pid}). Esperando /health ..."

  for _ in $(seq 1 80); do
    if is_server_ready; then
      echo "Servidor bot listo."
      return 0
    fi
    sleep 0.5
  done

  echo "ERROR: El bot no respondió en http://127.0.0.1:${PORT}/health" >&2
  echo "Revisa logs: ${SERVER_LOG_FILE}" >&2
  exit 1
}

stop_managed_server() {
  if [[ ! -f "$SERVER_PID_FILE" ]]; then
    return 0
  fi

  server_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${server_pid:-}" ]] && is_pid_running "$server_pid"; then
    kill_process_tree "$server_pid"
    echo "Servidor bot detenido (PID ${server_pid})."
  fi
  rm -f "$SERVER_PID_FILE"
}

start_ngrok() {
  if [[ -f "$PID_FILE" ]]; then
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_pid:-}" ]] && is_pid_running "$old_pid"; then
      echo "ngrok ya estaba activo (PID $old_pid)."
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  echo "Levantando tunel ngrok -> http://127.0.0.1:${PORT} ..."
  npx ngrok http "${PORT}" >"$LOG_FILE" 2>&1 &
  ngrok_pid=$!
  echo "$ngrok_pid" > "$PID_FILE"
}

wait_for_ngrok_url() {
  local url=""
  for _ in $(seq 1 60); do
    url="$(get_ngrok_url || true)"
    if [[ "$url" == https://* ]]; then
      echo "$url"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

set_telegram_webhook() {
  local ngrok_url="$1"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN no esta definido (carga .env primero)." >&2
    exit 1
  fi

  webhook_url="${ngrok_url}/webhook"
  echo "Webhook temporal: ${webhook_url}"

  delete_json="$(curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=${DROP_PENDING}")"
  echo "deleteWebhook: ${delete_json}"

  set_json="$(curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" -d "url=${webhook_url}")"
  echo "setWebhook: ${set_json}"

  info_json="$(curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")"
  echo "getWebhookInfo: ${info_json}"
}

print_status() {
  if is_server_ready; then
    echo "Servidor bot: OK (http://127.0.0.1:${PORT}/health)"
  else
    echo "Servidor bot: no responde en /health"
  fi

  if [[ -f "$SERVER_PID_FILE" ]]; then
    server_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
    echo "PID bot gestionado: ${server_pid:-desconocido}"
  else
    echo "PID bot gestionado: (ninguno)"
  fi

  local pid="(sin pid)"
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  echo "PID ngrok: ${pid}"

  local url
  url="$(get_ngrok_url || true)"
  if [[ "$url" == https://* ]]; then
    echo "URL ngrok: ${url}"
    echo "Webhook recomendado: ${url}/webhook"
  else
    echo "URL ngrok: no disponible (4040 sin tuneles)"
  fi
}

case "$ACTION" in
  start)
    start_server_if_needed
    start_ngrok
    ngrok_url="$(wait_for_ngrok_url || true)"
    if [[ "$ngrok_url" != https://* ]]; then
      echo "ERROR: No pude obtener URL publica de ngrok. Revisa ${LOG_FILE}" >&2
      exit 1
    fi
    set_telegram_webhook "$ngrok_url"
    echo "OK: ngrok queda en segundo plano. Logs: ${LOG_FILE}"
    echo "Tip: estado -> npm run webhook:ngrok -- status"
    echo "Tip: detener -> npm run webhook:ngrok -- stop"
    ;;
  status)
    print_status
    ;;
  stop)
    if [[ ! -f "$PID_FILE" ]]; then
      echo "No hay PID de ngrok para detener."
    else
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [[ -n "${pid:-}" ]] && is_pid_running "$pid"; then
        kill_process_tree "$pid"
        echo "ngrok detenido (PID ${pid})."
      else
        echo "ngrok no estaba activo."
      fi
      rm -f "$PID_FILE"
    fi
    stop_managed_server
    ;;
  *)
    echo "Uso: $0 [start|status|stop] [drop_pending_updates]" >&2
    echo "Ejemplo: $0 start true" >&2
    exit 1
    ;;
esac
