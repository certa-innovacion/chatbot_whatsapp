// src/bot/peritolineAutoSync.js
// Disparador asíncrono para sincronizar un encargo en PeritoLine al cerrar conversación.

const path = require('path');
const { spawn } = require('child_process');
const log = require('../utils/logger');

const AUTO_SYNC_ENABLED = !/^(0|false|no)$/i.test(String(process.env.PERITOLINE_AUTO_SYNC || 'true'));
const AUTO_SYNC_COOLDOWN_MS = Number(process.env.PERITOLINE_AUTO_SYNC_COOLDOWN_MS || 45000);

const running = new Set();
const lastRunByEncargo = new Map();
// Cola para syncs finales que llegaron mientras había una en curso
const pendingFinal = new Map(); // key → { anotacion }

function _spawn(key, reason, anotacion, assignOnly, isFinalSync) {
  lastRunByEncargo.set(key, Date.now());
  running.add(key);

  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'peritoline_sync.js');
  const cwd = path.join(__dirname, '..', '..');
  const spawnArgs = [scriptPath, '--encargo', key];
  if (anotacion)    spawnArgs.push('--anotacion', anotacion);
  if (assignOnly)   spawnArgs.push('--assign-only');
  if (isFinalSync)  spawnArgs.push('--final-sync');
  const child = spawn(process.execPath, spawnArgs, {
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
    _drainPending(key);
  });

  child.on('exit', (code) => {
    running.delete(key);
    if (code === 0) {
      log.info(`✅ PeritoLine auto-sync finalizado | encargo=${key}`);
    } else {
      log.error(`❌ PeritoLine auto-sync terminó con error | encargo=${key} | code=${code}`);
    }
    _drainPending(key);
  });

  child.unref();
}

function _drainPending(key) {
  if (!pendingFinal.has(key)) return;
  const { anotacion } = pendingFinal.get(key);
  pendingFinal.delete(key);
  log.info(`▶ Ejecutando final-sync pendiente | encargo=${key}`);
  _spawn(key, 'pending_final', anotacion, false, true);
}

function triggerEncargoSync(encargo, reason = '', anotacion = '', assignOnly = false, isFinalSync = false) {
  const key = String(encargo || '').trim();
  if (!key) return;
  if (!AUTO_SYNC_ENABLED) return;

  if (running.has(key)) {
    if (isFinalSync) {
      // Guardar para ejecutar en cuanto termine el proceso actual
      pendingFinal.set(key, { anotacion });
      log.info(`⏳ PeritoLine final-sync encolado (sync en curso) | encargo=${key}`);
    } else {
      log.info(`⏭️  PeritoLine auto-sync omitido (ya en curso) | encargo=${key}`);
    }
    return;
  }

  // Los syncs finales omiten el cooldown (pueden llegar justo después de otra sync)
  const now = Date.now();
  const last = lastRunByEncargo.get(key) || 0;
  if (!isFinalSync && now - last < AUTO_SYNC_COOLDOWN_MS) {
    log.info(`⏭️  PeritoLine auto-sync omitido (cooldown) | encargo=${key}`);
    return;
  }

  _spawn(key, reason, anotacion, assignOnly, isFinalSync);
}

module.exports = { triggerEncargoSync };
