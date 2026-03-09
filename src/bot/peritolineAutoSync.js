// src/bot/peritolineAutoSync.js
// Disparador asíncrono para sincronizar un encargo en PeritoLine al cerrar conversación.

const path = require('path');
const { spawn } = require('child_process');
const log = require('../utils/logger');

const AUTO_SYNC_ENABLED = !/^(0|false|no)$/i.test(String(process.env.PERITOLINE_AUTO_SYNC || 'true'));
const AUTO_SYNC_COOLDOWN_MS = Number(process.env.PERITOLINE_AUTO_SYNC_COOLDOWN_MS || 45000);

const running = new Set();
const lastRunByEncargo = new Map();

function triggerEncargoSync(encargo, reason = '') {
  const key = String(encargo || '').trim();
  if (!key) return;
  if (!AUTO_SYNC_ENABLED) return;

  const now = Date.now();
  const last = lastRunByEncargo.get(key) || 0;
  if (running.has(key)) {
    log.info(`⏭️  PeritoLine auto-sync omitido (ya en curso) | encargo=${key}`);
    return;
  }
  if (now - last < AUTO_SYNC_COOLDOWN_MS) {
    log.info(`⏭️  PeritoLine auto-sync omitido (cooldown) | encargo=${key}`);
    return;
  }

  lastRunByEncargo.set(key, now);
  running.add(key);

  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'peritoline_sync.js');
  const cwd = path.join(__dirname, '..', '..');
  const child = spawn(process.execPath, [scriptPath, '--encargo', key], {
    cwd,
    env: {
      ...process.env,
      PLAYWRIGHT_HEADLESS: String(process.env.PERITOLINE_AUTO_SYNC_HEADLESS || 'true'),
      PLAYWRIGHT_SLOW_MO: String(process.env.PERITOLINE_AUTO_SYNC_SLOW_MO || '0'),
      PERITOLINE_DRY_RUN: String(process.env.PERITOLINE_AUTO_SYNC_DRY_RUN || 'false'),
    },
    stdio: 'inherit',
  });

  log.info(`🚀 PeritoLine auto-sync lanzado | encargo=${key}${reason ? ` | motivo=${reason}` : ''}`);

  child.on('error', (err) => {
    running.delete(key);
    log.error(`❌ Error lanzando PeritoLine auto-sync | encargo=${key}:`, err.message);
  });

  child.on('exit', (code) => {
    running.delete(key);
    if (code === 0) {
      log.info(`✅ PeritoLine auto-sync finalizado | encargo=${key}`);
    } else {
      log.error(`❌ PeritoLine auto-sync terminó con error | encargo=${key} | code=${code}`);
    }
  });

  // No bloquear el proceso principal del bot.
  child.unref();
}

module.exports = { triggerEncargoSync };
