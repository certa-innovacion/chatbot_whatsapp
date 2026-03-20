// src/bot/reminderScheduler.js — Scheduler unificado
//
// Regla de negocio: solo contactamos al asegurado UNA VEZ (mensaje inicial).
// La columna "Contacto" del Excel es la fuente de verdad:
//   - Vacío    → pendiente de contactar (sendInitialMessage.js se encarga)
//   - "En curso" → ya contactado, conversación activa
//   - "Sí"     → flujo completado y perito virtual desasignado
//   - "No"     → asegurado no respondió, cerrado sin más contacto
//
// Gestiona dos escenarios:
//
//  A) SIN respuesta al primer mensaje (lastUserMessageAt = null)
//     → Cuando expira el timer, cierra la conversación SIN enviar ningún
//       mensaje adicional y marca Contacto = "No".
//
//  B) INACTIVIDAD a mitad de conversación (lastUserMessageAt existe pero el
//     usuario lleva demasiado tiempo sin escribir)
//     → Envía mensajes de inactividad generados por IA cada
//       INACTIVITY_INTERVAL_MINUTES, hasta INACTIVITY_MAX_ATTEMPTS veces.
//       Tras agotar los intentos cierra y marca Contacto = "No".
//
//  Los mensajes solo se envían dentro del horario L-V BUSINESS_HOURS_START–BUSINESS_HOURS_END.
//  La limpieza del Excel se ejecuta en cada ciclo independientemente del horario.

require('dotenv').config();
const conversationManager = require('./conversationManager');
const adapter             = require('../channels/whatsappAdapter');
const { buildInitialTemplateText } = require('./templateSender');
const { triggerEncargoSync } = require('./peritolineAutoSync');
const { isBusinessHours, cleanOldRows } = require('../utils/excelManager');
const { procesarConIA }   = require('../ai/aiModel');
const { generateConversationPdf, cleanOldPdfs, cleanOldDebugLogs } = require('../utils/pdfGenerator');
const fileLogger          = require('../utils/fileLogger');

const CHECK_MINUTES      = Number(process.env.SCHEDULER_CHECK_MINUTES         || 15);
const INACTIVITY_MINUTES = Number(process.env.INACTIVITY_INTERVAL_MINUTES     || process.env.INACTIVITY_INTERVAL_HOURS * 60  || 120);
const INACTIVITY_MAX     = Number(process.env.INACTIVITY_MAX_ATTEMPTS         || 3);

const INACTIVITY_MS = INACTIVITY_MINUTES * 60000;
const BH_START      = Number(process.env.BUSINESS_HOURS_START || 9);

let _timer = null;

/**
 * Calcula el timestamp de inicio del próximo período laboral (L-V, BH_START:00).
 * Si ahora es un día laborable antes de la hora de apertura, devuelve hoy a BH_START:00.
 * En cualquier otro caso (tarde, finde), devuelve el próximo día laborable a BH_START:00.
 */
function nextBusinessHoursStart() {
  const d = new Date();
  const day = d.getDay(); // 0=dom, 6=sab
  const hour = d.getHours();

  if (day >= 1 && day <= 5 && hour < BH_START) {
    // Hoy mismo, antes de abrir
    d.setHours(BH_START, 0, 0, 0);
    return d.getTime();
  }

  // Siguiente día laborable
  d.setDate(d.getDate() + 1);
  d.setHours(BH_START, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

// ── Lógica de comprobación ────────────────────────────────────────────────────

async function runChecks() {
  // Limpieza del Excel, PDFs y debug logs (sin restricción de horario)
  cleanOldRows();
  cleanOldPdfs();
  cleanOldDebugLogs();

  const now           = Date.now();
  const enHorario     = isBusinessHours();
  const TERMINAL      = new Set(['cerrado', 'finalizado', 'escalated']);
  const conversaciones = conversationManager.getAllConversations()
    .filter(c => c.status === 'pending');

  for (const conv of conversaciones) {
    const { waId, nexp } = conv;
    if (!waId || !nexp) continue;

    // Saltar conversaciones en stage terminal (cerrado, finalizado, escalated)
    if (TERMINAL.has(conv.stage)) continue;

    // nextReminderAt aún no ha llegado
    if (conv.nextReminderAt && conv.nextReminderAt > now) continue;

    if (!enHorario) {
      // El timer ya venció pero estamos fuera de horario: posponer al inicio
      // del próximo período laboral para no acumular "deuda" de tiempo.
      conversationManager.createOrUpdateConversation(waId, {
        nextReminderAt: nextBusinessHoursStart(),
      });
      continue;
    }

    const usuarioRespondio = Boolean(conv.lastUserMessageAt);

    if (!usuarioRespondio) {
      // ── Escenario A: sin respuesta al primer mensaje ──────────────────────
      // Regla: solo contactamos una vez. Cerrar sin enviar ningún mensaje más.
      await finalizarSinMensaje(waId, nexp);
    } else {
      // ── Escenario B: inactividad a mitad de conversación ──────────────────
      await handleInactivity(conv, now);
    }
  }
}

async function finalizarSinMensaje(waId, nexp) {
  try {
    conversationManager.createOrUpdateConversation(waId, {
      stage:    'cerrado',
      contacto: 'No',
    });
    triggerEncargoSync(nexp, 'inactividad_contacto_no', '[IA] Asegurado no responde', false, true);
    console.log(`📭 Sin respuesta, cerrado sin recontactar: nexp=${nexp}`);
    fileLogger.writeLog(nexp, 'INFO', `Cerrado por no respuesta (sin mensaje adicional) waId=${waId}`);
  } catch (err) {
    console.error(`❌ Error cerrando sin mensaje ${waId}:`, err.message);
    fileLogger.writeLog(nexp, 'ERROR', `Error cerrando sin mensaje waId=${waId}: ${err.message}`);
  }
}

async function handleInactivity(conv, now) {
  const { waId, nexp } = conv;
  const intentos = conv.inactivityAttempts || 0;

  if (intentos >= INACTIVITY_MAX) {
    await finalizar(waId, nexp, '[IA] Asegurado deja de responder');
    return;
  }

  const siguiente = intentos + 1;
  console.log(`💤 Inactividad ${siguiente}/${INACTIVITY_MAX} → nexp=${nexp}`);

  try {
    // Generar mensaje de inactividad con la IA
    const userData = conv.userData || {};
    const mensajesPrevios = conversationManager.getMensajes(waId);
    const historial = mensajesPrevios.map(m => ({
      role:  m.direction === 'in' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));
    const valoresExcel = {
      saludo:        new Date().getHours() < 12 ? 'Buenos días' : 'Buenas tardes',
      aseguradora:   userData.aseguradora   || 'la aseguradora',
      nexp,
      causa:         userData.causa         || '',
      observaciones: userData.observaciones || '',
      nombre:        userData.nombre        || 'el titular',
      direccion:     userData.direccion     || '',
      cp:            userData.cp            || '',
      municipio:     userData.municipio     || '',
    };

    const respuestaIA = await procesarConIA(historial, '[SISTEMA: INACTIVIDAD]', '', valoresExcel);
    const msgInactividad = respuestaIA.mensaje_para_usuario;

    await adapter.sendText(waId, msgInactividad);

    // Guardar el mensaje en el historial
    conversationManager.saveMensajes(waId, [
      ...mensajesPrevios,
      { direction: 'out', text: msgInactividad, timestamp: new Date().toISOString() },
    ]);

    conversationManager.createOrUpdateConversation(waId, {
      inactivityAttempts: siguiente,
      lastReminderAt:     now,
      nextReminderAt:     now + INACTIVITY_MS,
    });
    console.log(`✅ Mensaje de inactividad enviado (${siguiente}/${INACTIVITY_MAX}): "${msgInactividad}"`);
    if (siguiente >= INACTIVITY_MAX) {
      await finalizar(waId, nexp, '[IA] Asegurado deja de responder');
    }
  } catch (err) {
    console.error(`❌ Error enviando inactividad ${waId}:`, err.message);
    fileLogger.writeLog(nexp, 'ERROR', `Error enviando inactividad waId=${waId}: ${err.message}`);
  }
}

async function finalizar(waId, nexp, anotacion = '') {
  try {
    const conv = conversationManager.getConversation(waId);
    let mensajes = conversationManager.getMensajes(waId);
    const userData = conv?.userData || {};

    // Si el historial está vacío, reconstruir el mensaje inicial de la plantilla para
    // que siempre aparezca en el PDF aunque el estado no se haya persistido correctamente.
    if (mensajes.length === 0 && userData.aseguradora && nexp) {
      mensajes = [{
        direction: 'out',
        text:      buildInitialTemplateText({ aseguradora: userData.aseguradora, nexp, causa: userData.causa || userData.observaciones || '' }),
        timestamp: null,
      }];
    }
    const historial = mensajes.map(m => ({
      role:  m.direction === 'in' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));
    const valoresExcel = {
      saludo:        new Date().getHours() < 12 ? 'Buenos días' : 'Buenas tardes',
      aseguradora:   userData.aseguradora   || 'la aseguradora',
      nexp,
      causa:         userData.causa         || '',
      observaciones: userData.observaciones || '',
      nombre:        userData.nombre        || 'el titular',
      direccion:     userData.direccion     || '',
      cp:            userData.cp            || '',
      municipio:     userData.municipio     || '',
    };
    const respuestaIA = await procesarConIA(historial, '[SISTEMA: INACTIVIDAD_FINAL]', '', valoresExcel);
    const msgCierre = respuestaIA.mensaje_para_usuario;
    await adapter.sendText(waId, msgCierre);

    // Incluir el mensaje de cierre en el historial antes de guardar y generar el PDF
    const mensajesConCierre = [
      ...mensajes,
      { direction: 'out', text: msgCierre, timestamp: new Date().toISOString() },
    ];
    conversationManager.createOrUpdateConversation(waId, {
      stage:    'cerrado',
      contacto: 'No',
      mensajes: mensajesConCierre,
    });
    triggerEncargoSync(nexp, 'inactividad_contacto_no', anotacion, false, true);
    console.log(`🚨 Escalado por inactividad: nexp=${nexp}`);

    // Generar PDF de transcripción al cerrar por inactividad
    generateConversationPdf(nexp, userData, mensajesConCierre, {
      stage:     'cerrado',
      contacto:  'No',
      attPerito: conv?.attPerito,
      danos:     conv?.danos,
      digital:   conv?.digital,
      horario:   conv?.horario,
    }).catch(e => {
      console.error(`❌ Error generando PDF nexp=${nexp}:`, e.message);
      fileLogger.writeLog(nexp, 'ERROR', `Error generando PDF: ${e.message}`);
    });
  } catch (err) {
    console.error(`❌ Error finalizando por inactividad ${waId}:`, err.message);
    fileLogger.writeLog(nexp, 'ERROR', `Error finalizando por inactividad waId=${waId}: ${err.message}`);
  }
}

// ── Arranque / parada ─────────────────────────────────────────────────────────

function startScheduler() {
  if (_timer) {
    console.log('⚠️  Scheduler ya está corriendo');
    return;
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║           SCHEDULER UNIFICADO INICIADO                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`   ⏱️  Verificación cada: ${CHECK_MINUTES} min`);
  console.log(`   📩 Sin respuesta:   cierre silencioso (sin recontactar)`);
  console.log(`   💤 Inactividad:     aviso cada ${INACTIVITY_MINUTES}min × ${INACTIVITY_MAX} veces`);
  console.log(`   🕐 Envíos: L-V ${process.env.BUSINESS_HOURS_START || 9}:00–${process.env.BUSINESS_HOURS_END || 20}:00\n`);

  runChecks().catch(e => console.error('❌ Error en verificación inicial:', e.message));

  _timer = setInterval(() => {
    runChecks().catch(e => console.error('❌ Error en scheduler:', e.message));
  }, CHECK_MINUTES * 60000);

  console.log('✅ Scheduler configurado\n');
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startScheduler, stopScheduler, runChecks, _test: { nextBusinessHoursStart } };
