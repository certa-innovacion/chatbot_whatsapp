// src/worker/sqsWorker.js
// Worker que consume jobs de la cola SQS y ejecuta peritoline_sync.js
//
// Desplegado en las instancias EC2 worker (t3.large) lanzadas por Auto Scaling.
// Cada worker puede procesar hasta MAX_CONCURRENT_JOBS trabajos simultáneamente.
//
// Uso:
//   node src/worker/sqsWorker.js
//
// Variables de entorno requeridas (las mismas que el bot + las de PeritoLine):
//   SQS_QUEUE_URL          URL de la cola SQS
//   AWS_REGION             Región (default: eu-south-2)
//   MAX_CONCURRENT_JOBS    Máximo de Playwright simultáneos (default: 2)
//   WORKER_SHUTDOWN_IDLE_MS Tiempo sin mensajes para apagarse solo (default: 10 min)
//   ... y todas las variables de .env del bot (LOGIN_URL, USERNAME, PASSWORD, etc.)

require('dotenv').config({ override: true });

const { spawn }  = require('child_process');
const path       = require('path');
const os         = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const SQS_QUEUE_URL         = (process.env.SQS_QUEUE_URL || '').trim();
const AWS_REGION            = (process.env.AWS_REGION || 'eu-south-2').trim();
const MAX_CONCURRENT_JOBS   = Number(process.env.MAX_CONCURRENT_JOBS   || 2);
const POLL_WAIT_SECONDS     = Number(process.env.SQS_POLL_WAIT_SECONDS || 20);   // long polling
const VISIBILITY_TIMEOUT    = Number(process.env.SQS_VISIBILITY_TIMEOUT || 300); // 5 min
const IDLE_SHUTDOWN_MS      = Number(process.env.WORKER_SHUTDOWN_IDLE_MS || 10 * 60 * 1000);

if (!SQS_QUEUE_URL) {
  console.error('❌ SQS_QUEUE_URL no configurado. El worker no puede arrancar.');
  process.exit(1);
}

// ── Estado ────────────────────────────────────────────────────────────────────

let activeJobs   = 0;
let lastActivity = Date.now();
let shuttingDown = false;

// ── SQS Client ────────────────────────────────────────────────────────────────

let sqsClient;
let ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand;

try {
  const sqsSdk = require('@aws-sdk/client-sqs');
  sqsClient                      = new sqsSdk.SQSClient({ region: AWS_REGION });
  ReceiveMessageCommand          = sqsSdk.ReceiveMessageCommand;
  DeleteMessageCommand           = sqsSdk.DeleteMessageCommand;
  ChangeMessageVisibilityCommand = sqsSdk.ChangeMessageVisibilityCommand;
} catch (err) {
  console.error('❌ @aws-sdk/client-sqs no instalado. Ejecuta: npm install @aws-sdk/client-sqs');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getMemFreeMB() {
  return Math.round(os.freemem() / 1048576);
}

function runSyncJob(job) {
  const { key, reason, anotacion, assignOnly, isFinalSync } = job;
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'peritoline_sync.js');
  const cwd        = path.resolve(__dirname, '..', '..');

  const args = [scriptPath, '--encargo', key];
  if (anotacion)   args.push('--anotacion', anotacion);
  if (assignOnly)  args.push('--assign-only');
  if (isFinalSync) args.push('--final-sync');

  return new Promise((resolve, reject) => {
    log(`▶ Lanzando sync | encargo=${key} | motivo=${reason} | finalSync=${isFinalSync} | RAM libre: ${getMemFreeMB()}MB`);

    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        PLAYWRIGHT_HEADLESS: String(process.env.PERITOLINE_AUTO_SYNC_HEADLESS || 'true'),
        PLAYWRIGHT_SLOW_MO:  String(process.env.PERITOLINE_AUTO_SYNC_SLOW_MO  || '0'),
        PERITOLINE_DRY_RUN:  String(process.env.PERITOLINE_AUTO_SYNC_DRY_RUN  || 'false'),
      },
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      log(`❌ Error lanzando proceso | encargo=${key}: ${err.message}`);
      reject(err);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        log(`✅ Sync completado | encargo=${key}`);
        resolve();
      } else {
        log(`❌ Sync terminó con código ${code} | encargo=${key}`);
        reject(new Error(`Exit code ${code}`));
      }
    });
  });
}

// ── Ciclo de polling ──────────────────────────────────────────────────────────

async function pollOnce() {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    log(`⏳ Concurrencia al límite (${activeJobs}/${MAX_CONCURRENT_JOBS}), esperando...`);
    await new Promise(r => setTimeout(r, 5000));
    return;
  }

  const maxMessages = MAX_CONCURRENT_JOBS - activeJobs;

  const receiveCmd = new ReceiveMessageCommand({
    QueueUrl:            SQS_QUEUE_URL,
    MaxNumberOfMessages: Math.min(maxMessages, 10),
    WaitTimeSeconds:     POLL_WAIT_SECONDS,
    VisibilityTimeout:   VISIBILITY_TIMEOUT,
  });

  let result;
  try {
    result = await sqsClient.send(receiveCmd);
  } catch (err) {
    log(`❌ Error recibiendo mensajes de SQS: ${err.message}`);
    await new Promise(r => setTimeout(r, 10000));
    return;
  }

  const messages = result.Messages || [];
  if (!messages.length) {
    const idleMs = Date.now() - lastActivity;
    if (idleMs > IDLE_SHUTDOWN_MS && activeJobs === 0) {
      log(`😴 Sin actividad durante ${Math.round(idleMs / 60000)} min. Apagando worker.`);
      process.exit(0);
    }
    return;
  }

  lastActivity = Date.now();
  log(`📩 Recibidos ${messages.length} mensaje(s) de SQS`);

  for (const message of messages) {
    let job;
    try {
      job = JSON.parse(message.Body);
    } catch {
      log(`⚠️  Mensaje con body inválido, descartando: ${message.MessageId}`);
      await deleteSqsMessage(message.ReceiptHandle);
      continue;
    }

    activeJobs++;
    log(`🔧 Procesando job | encargo=${job.key} | jobs activos: ${activeJobs}/${MAX_CONCURRENT_JOBS}`);

    runSyncJob(job)
      .then(async () => {
        await deleteSqsMessage(message.ReceiptHandle);
      })
      .catch(async (err) => {
        log(`❌ Job falló | encargo=${job.key}: ${err.message}. Devolviendo a la cola.`);
        await resetSqsVisibility(message.ReceiptHandle);
      })
      .finally(() => {
        activeJobs--;
        lastActivity = Date.now();
        log(`🏁 Job finalizado | encargo=${job.key} | jobs activos: ${activeJobs}/${MAX_CONCURRENT_JOBS} | RAM libre: ${getMemFreeMB()}MB`);
      });
  }
}

async function deleteSqsMessage(receiptHandle) {
  try {
    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl:      SQS_QUEUE_URL,
      ReceiptHandle: receiptHandle,
    }));
  } catch (err) {
    log(`⚠️  Error eliminando mensaje de SQS: ${err.message}`);
  }
}

async function resetSqsVisibility(receiptHandle) {
  try {
    await sqsClient.send(new ChangeMessageVisibilityCommand({
      QueueUrl:          SQS_QUEUE_URL,
      ReceiptHandle:     receiptHandle,
      VisibilityTimeout: 30,
    }));
  } catch (err) {
    log(`⚠️  Error cambiando visibility de mensaje SQS: ${err.message}`);
  }
}

// ── Bucle principal ───────────────────────────────────────────────────────────

async function run() {
  log(`─────────────────────────────────────────────────────`);
  log(`    🤖 PeritoLine SQS Worker`);
  log(`─────────────────────────────────────────────────────`);
  log(`📋 Cola:              ${SQS_QUEUE_URL}`);
  log(`🌍 Región:            ${AWS_REGION}`);
  log(`🔧 Max jobs:          ${MAX_CONCURRENT_JOBS}`);
  log(`⏰ Idle shutdown:     ${IDLE_SHUTDOWN_MS / 60000} min`);
  log(`💾 RAM disponible:    ${getMemFreeMB()} MB`);

  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (err) {
      log(`❌ Error inesperado en ciclo de polling: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Señales de apagado ────────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`🛑 Señal ${signal} recibida. Esperando a que terminen ${activeJobs} job(s) activo(s)...`);

  const wait = setInterval(() => {
    if (activeJobs === 0) {
      clearInterval(wait);
      log('✅ Worker apagado limpiamente.');
      process.exit(0);
    }
    log(`⏳ Esperando ${activeJobs} job(s)...`);
  }, 3000);

  setTimeout(() => {
    log('⚠️  Cierre forzado tras timeout.');
    process.exit(1);
  }, 5 * 60 * 1000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

run().catch(err => {
  console.error('❌ Error fatal en worker:', err);
  process.exit(1);
});
