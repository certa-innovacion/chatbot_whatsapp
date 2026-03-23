#!/bin/bash
# scripts/start_worker.sh
# Script de arranque para instancias EC2 worker.
# Este script se ejecuta automáticamente al arrancar cada worker via User Data.
#
# Para configurarlo en el Launch Template:
#   Advanced details → User data → pegar este contenido

set -e

cd /home/ec2-user/chatbot_ia  # ajusta la ruta si es diferente

echo "─────────────────────────────────────────"
echo "  Arrancando PeritoLine SQS Worker"
echo "─────────────────────────────────────────"

# Verificar que el .env existe
if [ ! -f .env ]; then
  echo "❌ Archivo .env no encontrado en $(pwd)"
  exit 1
fi

# Instalar dependencias si no están
npm install --production

# Instalar Playwright y sus dependencias del sistema
npx playwright install chromium
npx playwright install-deps chromium

echo "✅ Dependencias listas"
echo "💾 RAM disponible: $(free -m | awk '/^Mem:/{print $7}') MB"

# Arrancar el worker
node src/worker/sqsWorker.js
