// src/bot/peritolineAutoSync.js
// Disparador asíncrono para sincronizar un encargo en PeritoLine.
//
// MODO DISTRIBUIDO (SQS_QUEUE_URL configurado):
//   Envía el job a la cola SQS. Los workers EC2 consumen la cola y ejecutan Playwright.
//
// MODO LOCAL (sin SQS_QUEUE_URL):
//   Comportamiento original — lanza Playwright como child process en el mismo servidor.
//
// Garantías:
//  · Máximo MAX_CONCURRENT instancias de Playwright simultáneas (modo local).
//  · Cola persistente de reintentos para syncs que fallan por recursos.
//  · Deduplicación: un isFinalSync siempre reemplaza a un assignOnly pendiente del mismo encargo.
//  · No se producen comunicaciones duplicadas con el asegurado: los mensajes WhatsApp se envían
//    ANTES de llamar a este módulo; los reintentos solo tocan PeritoLine.

const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');
const log = require('../utils/logger');
const fileLogger = require('../utils/fileLogger');
const resourceMonitor = require('../utils/resourceMonitor');

// ── Configuración ─────────────────────────────────────────────────────────────

const AUTO_SYNC_ENABLED    = !/^(0|false|no)$/i.test(String(process.env.PERITOLINE_AUTO_SYNC || 'true'));
const AUTO_SYNC_COOLDOWN_MS = Number(process.env.PERITOLINE_AUTO_SYNC_COOLDOWN_MS || 45_000);
const MAX_CONCURRENT        = Number(process.env.PERITOLINE_MAX_CONCURRENT        || 2);
const MAX_RETRY_ATTEMPTS    = Number(process.env.PERITOLINE_MAX_RETRY_ATTEMPTS    || 5);
const RETRY_CHECK_MS        = Number(process.env.PERITOLINE_RETRY_CHECK_MIN       || 5) * 60_000;
const RETRY_QUEUE_PATH      = path.resolve(__dirname, '../../data/sync_retry_queue.json');

// SQS: si está configurado, usar modo distribuido
const SQS_QUEUE_URL = (process.env.SQS_QUEUE_URL || '').trim();
const AWS_REGION    = (process.env.AWS_REGION || 'eu-south-2').trim();

// Backoff en minutos por número de intento (1-based)
const RETRY_BACKOFF_MIN = [0, 5, 15, 30, 60, 120];

// ── Estado en memoria ─────────────────────────────────────────────────────────

const running          = new Set();          // encargos con Playwright activo
const lastRunByEncargo = new Map();          // encargo → timestamp último spawn
const pendingFinal     = new Map();          // encargo → { anotacion } para final-sync encolado
let   runningCount     = 0;                  // total de instancias Playwright activas
const globalQueue      = [];                 // cola global por límite de concurrencia

// ── Cliente SQS (lazy init) ───────────────────────────────────────────────────

let _sqsClient = null;

function getSqsClient() {
  if (_sqsClient) return _sqsClient;
  try {
    const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
    _sqsClient = { client: new SQSClient({ region: AWS_REGION }), SendMessageCommand };
    log.info(`📨 SQS client inicializado | región: ${AWS_REGION} | cola: ${SQS_QUEUE_URL}`);
  } catch (err) {
    log.error('❌ No se pudo cargar @aws-sdk/client-sqs. Ejecuta: npm install @aws-sdk/client-sqs');
    _sqsClient = null;
  }
  return _sqsClient;
}

// ── Cola persistente de reintentos ────────────────────────────────────────────

function _loadRetryQueue() {
  try {
    if (fs.existsSync(RETRY_QUEUE_PATH)) {
      return JSON.parse(fs.readFileSync(RETRY_QUEUE_PATH, 'utf8')) || [];
    }
  } catch (e) {
    log.error('❌ Error leyendo cola de reintentos:', e.message);
  }
  return [];
}

function _saveRetryQueue(queue) {
  try {
    fs.writeFileSync(RETRY_QUEUE_PATH, JSON.stringify(queue, null, 2));
  } catch (e) {
    log.error('❌ Error guardando cola de reintentos:', e.message);
  }
}

function _enqueueRetry(key, reason, anotacion, assignOnly, isFinalSync) {
  const queue = _loadRetryQueue();
  const idx   = queue.findIndex(e => e.key === key);
  const existing = idx !== -1 ? queue[idx] : null;

  if (existing && existing.isFinalSync && assignOnly) {
    log.info(`⏭️  Reintento assign-only ignorado (ya hay finalSync en cola) | encargo=${key}`);
    return;
  }

  const now       = Date.now();
  const attempts  = existing ? existing.attempts : 0;
  const backoffMs = (RETRY_BACKOFF_MIN[Math.min(attempts + 1, RETRY_BACKOFF_MIN.length - 1)] || 120) * 60_000;

  const entry = {
    key,
    reason,
    anotacion:   anotacion || (existing?.anotacion || ''),
    assignOnly:  isFinalSync ? false : assignOnly,
    isFinalSync: isFinalSync || (existing?.isFinalSync || false),
    failedAt:    existing?.failedAt || now,
    attempts,
    nextRetryAt: now + backoffMs,
  };

  if (idx !== -1) queue[idx] = entry;
  else            queue.push(entry);

  _saveRetryQueue(queue);
  log.warn(`🔁 Sync añadido a cola de reintentos | encargo=${key} | intento=${attempts + 1}/${MAX_RETRY_ATTEMPTS}`);
}

function _removeFromRetryQueue(key) {
  const queue = _loadRetryQueue().filter(e => e.key !== key);
  _saveRetryQueue(queue);
}

// ── Envío a SQS (modo distribuido) ───────────────────────────────────────────

async function _sendToSqs(key, reason, anotacion, assignOnly, isFinalSync) {
  const sqs = getSqsClient();
  if (!sqs) {
    log.warn(`⚠️  SQS SDK no disponible, fallback a modo local | encargo=${key}`);
    _spawnLocal(key, reason, anotacion, assignOnly, isFinalSync);
    return;
  }

  const { client, SendMessageCommand } = sqs;
  const messageBody = JSON.stringify({ key, reason, anotacion, assignOnly, isFinalSync });

  const isFifo = SQS_QUEUE_URL.endsWith('.fifo');
  const params = {
    QueueUrl:    SQS_QUEUE_URL,
    MessageBody: messageBody,
    ...(isFifo ? {
      MessageGroupId:         key,
      MessageDeduplicationId: `${key}-${Date.now()}`,
    } : {}),
  };

  try {
    const result = await client.send(new SendMessageCommand(params));
    log.info(`📨 Job enviado a SQS | encargo=${key} | motivo=${reason} | msgId=${result.MessageId}`);
    fileLogger.forNexp(key).playwright(`=== Job enviado a SQS | motivo=${reason} ===`);
    lastRunByEncargo.set(key, Date.now());
  } catch (err) {
    log.error(`❌ Error enviando a SQS | encargo=${key}:`, err.message);
    fileLogger.forNexp(key).error(`Error enviando job a SQS: ${err.message}`);
    _enqueueRetry(key, reason, anotacion, assignOnly, isFinalSync);
  }
}

// ── Spawn local (modo original, sin SQS) ─────────────────────────────────────

function _spawnLocal(key, reason, anotacion, assignOnly, isFinalSync, isRetry = false) {
  lastRunByEncargo.set(key, Date.now());
  running.add(key);
  runningCount++;

  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'peritoline_sync.js');
  const cwd        = path.join(__dirname, '..', '..');
  const spawnArgs  = [scriptPath, '--encargo', key];
  if (anotacion)   spawnArgs.push('--anotacion', anotacion);
  if (assignOnly)  spawnArgs.push('--assign-only');
  if (isFinalSync) spawnArgs.push('--final-sync');

  const FL     = fileLogger.forNexp(key);
  const retry  = isRetry ? ' [REINTENTO]' : '';
  const header = `=== Sync iniciado${retry} | encargo=${key}${reason ? ` | motivo=${reason}` : ''} ===`;

  resourceMonitor.logStats(`before_spawn_${key}`).then(({ cpuPct, mem }) => {
    log.info(`🚀 PeritoLine auto-sync lanzado${retry} | encargo=${key} | CPU:${cpuPct}% | RAM libre:${mem.freeMB}MB | concurrent:${runningCount}/${MAX_CONCURRENT}`);
  });

  FL.playwright(header);

  const child = spawn(process.execPath, spawnArgs, {
    cwd,
    env: {
      ...process.env,
      PLAYWRIGHT_HEADLESS: String(process.env.PERITOLINE_AUTO_SYNC_HEADLESS || 'true'),
      PLAYWRIGHT_SLOW_MO:  String(process.env.PERITOLINE_AUTO_SYNC_SLOW_MO  || '0'),
      PERITOLINE_DRY_RUN:  String(process.env.PERITOLINE_AUTO_SYNC_DRY_RUN  || 'false'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(chunk);
    text.split('\n').filter(l => l.trim()).forEach(l => FL.playwright(l));
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(chunk);
    text.split('\n').filter(l => l.trim()).forEach(l => FL.playwright(`[STDERR] ${l}`));
  });

  child.on('error', (err) => {
    running.delete(key);
    runningCount = Math.max(0, runningCount - 1);
    log.error(`❌ Error lanzando PeritoLine auto-sync | encargo=${key}:`, err.message);
    FL.playwright(`[ERROR] Error lanzando proceso: ${err.message}`);
    FL.error(`Error lanzando PeritoLine auto-sync: ${err.message}`);
    _enqueueRetry(key, reason, anotacion, assignOnly, isFinalSync);
    _afterProcess(key);
  });

  child.on('exit', (code) => {
    running.delete(key);
    runningCount = Math.max(0, runningCount - 1);

    if (code === 0) {
      log.info(`✅ PeritoLine auto-sync finalizado | encargo=${key}`);
      FL.playwright(`=== Sync finalizado OK | encargo=${key} ===`);
      _removeFromRetryQueue(key);
    } else {
      resourceMonitor.logStats(`after_failure_${key}`).then(({ cpuPct, mem }) => {
        log.error(`❌ PeritoLine auto-sync terminó con error | encargo=${key} | code=${code} | CPU:${cpuPct}% | RAM libre:${mem.freeMB}MB`);
      });
      FL.playwright(`[ERROR] Sync terminó con código ${code} | encargo=${key}`);
      FL.error(`PeritoLine auto-sync terminó con error | code=${code}`);
      _enqueueRetry(key, reason, anotacion, assignOnly, isFinalSync);
    }

    _afterProcess(key);
  });

  child.unref();
}

// ── Dispatcher principal ──────────────────────────────────────────────────────

/**
 * Decide si usar SQS (modo distribuido) o spawn local.
 * En modo SQS no aplicamos límite de concurrencia local — SQS + los workers
 * gestionan la concurrencia de forma natural.
 */
function _dispatch(key, reason, anotacion, assignOnly, isFinalSync, isRetry = false) {
  if (SQS_QUEUE_URL) {
    _sendToSqs(key, reason, anotacion, assignOnly, isFinalSync);
  } else {
    _spawnOrQueue(key, reason, anotacion, assignOnly, isFinalSync, isRetry);
  }
}

// ── Cola global (modo local) ──────────────────────────────────────────────────

function _afterProcess(key) {
  _drainPendingFinal(key);
  _drainGlobalQueue();
}

function _drainPendingFinal(key) {
  if (!pendingFinal.has(key)) return;
  const { anotacion } = pendingFinal.get(key);
  pendingFinal.delete(key);
  log.info(`▶ Ejecutando final-sync pendiente | encargo=${key}`);
  _spawnOrQueue(key, 'pending_final', anotacion, false, true);
}

function _drainGlobalQueue() {
  while (globalQueue.length > 0 && runningCount < MAX_CONCURRENT) {
    const next = globalQueue.shift();
    log.info(`▶ Procesando sync en cola global | encargo=${next.key} | pendientes restantes: ${globalQueue.length}`);
    _spawnLocal(next.key, next.reason, next.anotacion, next.assignOnly, next.isFinalSync);
  }
}

function _spawnOrQueue(key, reason, anotacion, assignOnly, isFinalSync, isRetry = false) {
  if (runningCount < MAX_CONCURRENT) {
    _spawnLocal(key, reason, anotacion, assignOnly, isFinalSync, isRetry);
  } else {
    log.info(`⏳ PeritoLine sync en cola global (${runningCount}/${MAX_CONCURRENT} activos) | encargo=${key}`);
    const existingIdx = globalQueue.findIndex(e => e.key === key);
    if (existingIdx !== -1) {
      const existing = globalQueue[existingIdx];
      if (isFinalSync && !existing.isFinalSync) {
        globalQueue[existingIdx] = { key, reason, anotacion, assignOnly, isFinalSync };
        log.info(`🔄 Cola global: assignOnly reemplazado por finalSync | encargo=${key}`);
      }
    } else {
      globalQueue.push({ key, reason, anotacion, assignOnly, isFinalSync });
    }
  }
}

// ── Scheduler de reintentos ───────────────────────────────────────────────────

async function _processRetryQueue() {
  const queue = _loadRetryQueue();
  if (!queue.length) return;

  const now       = Date.now();
  const due       = queue.filter(e => e.nextRetryAt <= now && e.attempts < MAX_RETRY_ATTEMPTS);
  const overLimit = queue.filter(e => e.attempts >= MAX_RETRY_ATTEMPTS);

  if (overLimit.length) {
    overLimit.forEach(e => {
      log.error(`💀 Sync abandonado tras ${e.attempts} intentos | encargo=${e.key} | motivo=${e.reason}`);
      fileLogger.forNexp(e.key).error(`Sync PeritoLine abandonado tras ${e.attempts} intentos | motivo=${e.reason}`);
    });
    _saveRetryQueue(queue.filter(e => e.attempts < MAX_RETRY_ATTEMPTS));
  }

  if (!due.length) return;

  // En modo SQS no comprobamos recursos locales (el worker lo gestiona)
  if (!SQS_QUEUE_URL) {
    const available = await resourceMonitor.isAvailable();
    if (!available) {
      const { cpuPct, mem } = resourceMonitor.getLastStats() || {};
      log.warn(`⚠️  Cola de reintentos: recursos insuficientes, postergando | CPU:${cpuPct}% | RAM libre:${mem?.freeMB}MB`);
      return;
    }
  }

  const entry = due[0];
  const updatedQueue = _loadRetryQueue().map(e => {
    if (e.key !== entry.key) return e;
    return { ...e, attempts: e.attempts + 1 };
  });
  _saveRetryQueue(updatedQueue);

  log.info(`🔁 Reintentando sync | encargo=${entry.key} | intento ${entry.attempts + 1}/${MAX_RETRY_ATTEMPTS}`);

  if (!SQS_QUEUE_URL && running.has(entry.key)) {
    log.info(`⏭️  Reintento omitido (ya en curso) | encargo=${entry.key}`);
    return;
  }

  _dispatch(entry.key, `retry_${entry.reason}`, entry.anotacion, entry.assignOnly, entry.isFinalSync, true);
}

// ── API pública ───────────────────────────────────────────────────────────────

function triggerEncargoSync(encargo, reason = '', anotacion = '', assignOnly = false, isFinalSync = false) {
  const key = String(encargo || '').trim();
  if (!key) return;
  if (!AUTO_SYNC_ENABLED) return;

  // En modo local: gestión de concurrencia y cooldown
  if (!SQS_QUEUE_URL) {
    if (running.has(key)) {
      if (isFinalSync) {
        pendingFinal.set(key, { anotacion });
        log.info(`⏳ PeritoLine final-sync encolado (sync en curso) | encargo=${key}`);
      } else {
        log.info(`⏭️  PeritoLine auto-sync omitido (ya en curso) | encargo=${key}`);
      }
      return;
    }

    const now  = Date.now();
    const last = lastRunByEncargo.get(key) || 0;
    if (!isFinalSync && now - last < AUTO_SYNC_COOLDOWN_MS) {
      log.info(`⏭️  PeritoLine auto-sync omitido (cooldown) | encargo=${key}`);
      return;
    }
  } else {
    // En modo SQS: solo aplicar cooldown para evitar duplicados en cola
    const now  = Date.now();
    const last = lastRunByEncargo.get(key) || 0;
    if (!isFinalSync && now - last < AUTO_SYNC_COOLDOWN_MS) {
      log.info(`⏭️  PeritoLine auto-sync omitido (cooldown SQS) | encargo=${key}`);
      return;
    }
  }

  _dispatch(key, reason, anotacion, assignOnly, isFinalSync);
}

function getQueueStatus() {
  return {
    mode:           SQS_QUEUE_URL ? 'sqs' : 'local',
    sqsQueueUrl:    SQS_QUEUE_URL || null,
    runningCount,
    maxConcurrent:  MAX_CONCURRENT,
    globalQueueLen: globalQueue.length,
    retryQueueLen:  _loadRetryQueue().length,
    retryQueue:     _loadRetryQueue().map(e => ({
      key:         e.key,
      attempts:    e.attempts,
      isFinalSync: e.isFinalSync,
      nextRetryAt: new Date(e.nextRetryAt).toISOString(),
    })),
  };
}

// ── Arranque ──────────────────────────────────────────────────────────────────

const _retryTimer = setInterval(_processRetryQueue, RETRY_CHECK_MS);
if (_retryTimer.unref) _retryTimer.unref();

const modeLabel = SQS_QUEUE_URL ? `SQS (${SQS_QUEUE_URL})` : `local (max ${MAX_CONCURRENT} concurrent)`;
log.info(`🔁 PeritoLine auto-sync iniciado | modo: ${modeLabel} | retry check: ${RETRY_CHECK_MS / 60_000} min`);

setTimeout(() => {
  const pending = _loadRetryQueue();
  if (pending.length) {
    log.warn(`📋 Cola de reintentos cargada al arranque: ${pending.length} entrada(s) pendiente(s)`);
    pending.forEach(e => log.warn(`   · encargo=${e.key} | intento=${e.attempts}/${MAX_RETRY_ATTEMPTS} | motivo=${e.reason}`));
  }
}, 3000);

module.exports = { triggerEncargoSync, getQueueStatus };
