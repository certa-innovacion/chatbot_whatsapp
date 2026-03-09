// src/bot/messageHandler.js
const conversationManager = require('./conversationManager');
const { procesarConIA }   = require('../ai/aiModel');
const adapter             = require('../channels/whatsappAdapter');
const { canProcess }      = require('./stateMachine');
const { triggerEncargoSync } = require('./peritolineAutoSync');
const { generateConversationPdf } = require('../utils/pdfGenerator');
const axios = require('axios');

// Mapeo entre los valores que devuelve la IA y los stages internos
const ESTADO_IA_TO_STAGE = {
  finalizado:      'finalizado',
  escalado_humano: 'escalated',
};

// Cache de CP → localidad para no repetir peticiones
const cpCache = {};
const RELATION_RE = /\b(?:mi|su)\s+(herman[oa]|padre|madre|hij[oa]|espos[oa]|marido|mujer|pareja|prim[oa]|tio|tia|sobrin[oa]|abuel[oa]|niet[oa]|cunad[oa]|yerno|nuera|representante|abogado|emplead[oa]|operari[oa]|limpieza|inquilin[oa]|arrendatari[oa]|vecin[oa]|amig[oa])\b/i;

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isPeritoAttendeePrompt(text) {
  const t = norm(text);
  return (
    (t.includes('quien') && t.includes('atendera') && t.includes('perito')) ||
    t.includes('atienda al perito') ||
    t.includes('atendera al perito') ||
    t.includes('atendera al perito cuando realice la visita') ||
    (t.includes('perito') && (t.includes('telefono') || t.includes('contactar'))) ||
    (t.includes('sera usted') && t.includes('atienda al perito'))
  );
}

function isPeritoAttendeeMentionInUser(text) {
  const t = norm(text);
  return (
    t.includes('atienda al perito') ||
    t.includes('atendera al perito') ||
    (t.includes('perito') && t.includes('atender'))
  );
}

function isAffirmativeAck(text) {
  const t = String(text || '').trim().toLowerCase();
  return /^(si|sí|ok|vale|perfecto|correcto|todo ok|todo correcto|de acuerdo|confirmado)$/.test(t);
}

function isDefinitiveClosingMessage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;

  // Señales de "resumen pendiente de confirmación": no debe cerrarse aún.
  if (
    t.includes('si algún dato no es correcto') ||
    t.includes('si algun dato no es correcto') ||
    t.includes('indíquenoslo para ajustarlo') ||
    t.includes('indiquenoslo para ajustarlo') ||
    t.includes('para comprobar que están correctos') ||
    t.includes('para comprobar que estan correctos')
  ) {
    return false;
  }

  // Señales de cierre definitivo.
  return (
    t.includes('finalizamos la gestión por este medio') ||
    t.includes('finalizamos la gestion por este medio') ||
    t.includes('finalizamos la comunicaci') ||
    t.includes('expediente ya está en gestión con el perito') ||
    t.includes('expediente ya esta en gestion con el perito') ||
    t.includes('trasladamos la información al perito') ||
    t.includes('trasladamos la informacion al perito') ||
    t.includes('le contactará el perito') ||
    t.includes('le contactara el perito')
  );
}

function normalizeContactPhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^\d{9}$/.test(digits) && /^[6-9]/.test(digits)) digits = `34${digits}`;
  return digits;
}

function extractRelationship(text) {
  const m = String(text || '').toLowerCase().match(RELATION_RE);
  return m?.[1] ? m[1] : '';
}

function detectEconomicEstimate(text) {
  const raw = String(text || '').trim();
  const lowered = raw.toLowerCase();
  if (!raw) return null;

  // Rango: "1000-3000", "entre 1000 y 3000", "de 1000 a 3000"
  const rangeMatch = lowered.match(/(?:entre\s+)?(\d{1,2}(?:[.,]\d{3})+|\d{1,5})\s*(?:-|a|y)\s*(\d{1,2}(?:[.,]\d{3})+|\d{1,5})/i);
  if (rangeMatch) {
    const a = rangeMatch[1].replace(/\./g, '');
    const b = rangeMatch[2].replace(/\./g, '');
    return `${a} - ${b} €`;
  }

  // Importe con símbolo/palabra de moneda
  const moneyMatch = lowered.match(/(\d{1,2}(?:[.,]\d{3})+|\d{1,5})(?:[.,]\d{1,2})?\s*(?:€|euros?|eur)\b/i);
  if (moneyMatch) {
    return `${moneyMatch[1].replace(/\./g, '')} €`;
  }

  // Solo número corto (p.ej. "200")
  const justNumber = lowered.match(/^(\d{1,4})(?:[.,]\d{1,2})?$/);
  if (justNumber) {
    return `${justNumber[1]} €`;
  }

  return null;
}

async function lookupCP(text) {
  const match = text.match(/\b(\d{5})\b/);
  if (!match) return null;
  const cp = match[1];
  if (cpCache[cp]) return cpCache[cp];
  try {
    const res = await axios.get(`https://api.zippopotam.us/es/${cp}`, { timeout: 3000 });
    const place = res.data.places?.[0];
    if (place) {
      const info = { cp, localidad: place['place name'], provincia: place.state };
      cpCache[cp] = info;
      return info;
    }
  } catch { /* CP no encontrado o API no disponible */ }
  return null;
}

/**
 * Procesa un mensaje entrante de WhatsApp.
 * @param {string} waId       - número sin + (ej. "34674742564")
 * @param {object} messageObj - objeto normalizado del whatsappAdapter
 */
async function processMessage(waId, messageObj) {
  try {
    const text = (messageObj.text || '').trim();
    if (!text) return;
    let stageAplicado = null;

    // Buscar el nexp vinculado a este número
    const nexp = conversationManager.getNexpByWaId(waId);
    if (!nexp) {
      console.log(`⚠️  Número ${waId} sin expediente vinculado — ignorando`);
      return;
    }

    // ── Máquina de estados ───────────────────────────────────────────────
    const conversation = conversationManager.getConversation(waId);
    const stateCheck = canProcess(conversation);
    if (!stateCheck.ok) {
      console.log(`⛔ [${waId}] bloqueado (${stateCheck.reason}) stage=${conversation?.stage}`);
      if (stateCheck.response) {
        await adapter.sendText(waId, stateCheck.response);
        if (conversation.stage === 'finalizado') {
          conversationManager.createOrUpdateConversation(waId, { stage: 'cerrado' });
        }
      }
      return;
    }

    // Registrar actividad (resetea inactivityAttempts y nextReminderAt)
    conversationManager.recordUserMessage(waId);

    // Leer datos del siniestro y mensajes desde Excel
    const userData        = conversation.userData || {};
    const mensajesPrevios = conversationManager.getMensajes(waId);
    const lastBotMessage = [...mensajesPrevios].reverse().find(m => m?.direction === 'out')?.text || '';
    const relationFromCurrent = extractRelationship(text);
    const peritoAttendeeContext = isPeritoAttendeePrompt(lastBotMessage) || isPeritoAttendeeMentionInUser(text);
    const relationAlreadyKnown = Boolean(
      (!peritoAttendeeContext && relationFromCurrent) ||
      (conversation.relacion && String(conversation.relacion).trim())
    );
    const estimateFromCurrent = detectEconomicEstimate(text);
    const estimateAlreadyKnown = Boolean((conversation.danos && String(conversation.danos).trim()) || estimateFromCurrent);

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

    const historial = mensajesPrevios.map(m => ({
      role:  m.direction === 'in' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));

    // Enriquecer contexto con CP si se detecta
    const cpInfo = await lookupCP(text);
    const hoy = new Date();
    const diasSemana = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const fechaHoy = `${String(hoy.getDate()).padStart(2,'0')}/${String(hoy.getMonth()+1).padStart(2,'0')}/${hoy.getFullYear()}`;
    let contextoSistema = `[INFO]: Fecha actual: ${diasSemana[hoy.getDay()]} ${fechaHoy}. Ubicación: ${valoresExcel.direccion}, CP ${valoresExcel.cp}, ${valoresExcel.municipio}.`;
    if (valoresExcel.observaciones) {
      contextoSistema += `\n[OBSERVACIONES DEL EXPEDIENTE]: ${valoresExcel.observaciones}`;
    }
    if (cpInfo) {
      contextoSistema += `\n[CP DETECTADO]: El código postal ${cpInfo.cp} corresponde a ${cpInfo.localidad} (${cpInfo.provincia}). No preguntes la localidad, úsala directamente.`;
    }
    contextoSistema += '\n[Videoperitación]: Si el usuario no expresa dudas, no expliques funcionamiento; pregunta disponibilidad directa (mañana/tarde).';
    contextoSistema += '\n[DISTINCIÓN DE CAMPOS]: "Relación" es SOLO la relación del interlocutor actual con el asegurado. "AT. Perito" es SOLO la persona que atenderá al perito en la visita.';
    if (peritoAttendeeContext) {
      contextoSistema += '\n[CONTEXTO ACTUAL]: El usuario está respondiendo sobre quién atenderá al perito. Extrae nombre_contacto/relacion_contacto/telefono_contacto para "AT. Perito". No cambies la columna "Relación" del interlocutor.';
    }
    if (relationAlreadyKnown) {
      contextoSistema += '\n[DATO YA INFORMADO]: El interlocutor ya ha indicado su relación con el asegurado. No vuelvas a preguntar la relación; solicita solo el dato que falte.';
    }
    if (estimateAlreadyKnown) {
      const estimateRef = estimateFromCurrent || String(conversation.danos || '').trim();
      contextoSistema += `\n[DATO YA INFORMADO]: Ya existe estimación económica (${estimateRef}). No la vuelvas a pedir y avanza al siguiente paso.`;
    }
    if (
      (lastBotMessage.toLowerCase().includes('si algún dato no es correcto') || lastBotMessage.toLowerCase().includes('si algun dato no es correcto')) &&
      isAffirmativeAck(text)
    ) {
      contextoSistema += '\n[CONFIRMACIÓN RESUMEN]: El usuario confirma que los datos están correctos. Envía despedida final y marca estado_expediente="finalizado".';
    }

    // ── Llamada a la IA ──────────────────────────────────────────────────
    const respuestaIA = await procesarConIA(historial, text, contextoSistema, valoresExcel);

    // Persistir mensajes y datos extraídos en el Excel
    if (respuestaIA.mensaje_entendido) {
      const {
        nombre_contacto,
        relacion_contacto,
        telefono_contacto,
        importe_estimado,
        acepta_videollamada,
        preferencia_horaria,
        estado_expediente,
      } = respuestaIA.datos_extraidos || {};

      const excelUpdates = {
        mensajes: [
          ...mensajesPrevios,
          { direction: 'in',  text, timestamp: new Date().toISOString() },
          { direction: 'out', text: respuestaIA.mensaje_para_usuario, timestamp: new Date().toISOString() },
        ],
      };
      const relacionInterlocutor = String(peritoAttendeeContext ? '' : (relationFromCurrent || relacion_contacto || '')).trim();
      if (relacionInterlocutor) {
        excelUpdates.relacion = relacionInterlocutor;
      }

      const shouldUpdateAttPerito = peritoAttendeeContext && Boolean(nombre_contacto || relacion_contacto || relationFromCurrent || telefono_contacto);
      if (shouldUpdateAttPerito) {
        const [exNombre = '', exRelacion = '', exTelefono = ''] = String(conversation.attPerito || '').split(' - ');
        const nombreAtt = String(nombre_contacto || '').trim() || (exNombre !== 'sin indicar' ? exNombre : '') || 'sin indicar';
        const relacionAtt = String(relacion_contacto || relationFromCurrent || '').trim() || (exRelacion !== 'sin indicar' ? exRelacion : '') || 'sin indicar';
        const telefonoAtt = normalizeContactPhone(telefono_contacto) || normalizeContactPhone(exTelefono) || normalizeContactPhone(waId);
        excelUpdates.attPerito = `${nombreAtt} - ${relacionAtt} - ${telefonoAtt}`;
      }
      if (importe_estimado || estimateFromCurrent) {
        excelUpdates.danos = String(importe_estimado || estimateFromCurrent).trim();
      }
      if (typeof acepta_videollamada === 'boolean') {
        excelUpdates.digital = acepta_videollamada ? 'Sí' : 'No';
      }
      if (preferencia_horaria === 'mañana') excelUpdates.horario = 'Mañana';
      else if (preferencia_horaria === 'tarde') excelUpdates.horario = 'Tarde';

      const nuevoStage = ESTADO_IA_TO_STAGE[estado_expediente];
      if (nuevoStage) {
        if (nuevoStage === 'finalizado' && !isDefinitiveClosingMessage(respuestaIA.mensaje_para_usuario)) {
          console.warn(`⚠️  IA marcó "finalizado" sin despedida explícita; no se cierra aún | Expediente: ${nexp}`);
        } else {
          stageAplicado = nuevoStage;
          excelUpdates.stage = nuevoStage;
          excelUpdates.contacto = 'Sí'; // Conversación terminada con el asegurado
          console.log(`🔄 Stage actualizado → ${nuevoStage} | Expediente: ${nexp}`);
        }
      }

      conversationManager.createOrUpdateConversation(waId, excelUpdates);

      // Disparo automático a PeritoLine cuando se cierra conversación con contacto válido.
      if (excelUpdates.contacto === 'Sí' && (stageAplicado === 'finalizado' || stageAplicado === 'escalated')) {
        triggerEncargoSync(nexp, `stage_${stageAplicado}`);
      }

      // Generar PDF de transcripción al finalizar la conversación
      if (stageAplicado === 'finalizado' || stageAplicado === 'escalated') {
        const allMsgs = excelUpdates.mensajes || conversationManager.getMensajes(waId);
        generateConversationPdf(nexp, userData, allMsgs, {
          stage:     stageAplicado,
          contacto:  excelUpdates.contacto,
          attPerito: conversation.attPerito,
          danos:     conversation.danos     || excelUpdates.danos,
          digital:   conversation.digital   || excelUpdates.digital,
          horario:   conversation.horario   || excelUpdates.horario,
        }).catch(e => console.error(`❌ Error generando PDF nexp=${nexp}:`, e.message));
      }
    }

    // ── Enviar respuesta ─────────────────────────────────────────────────
    console.log(`🤖 Respuesta IA: "${respuestaIA.mensaje_para_usuario}"`);
    if (!respuestaIA.mensaje_para_usuario) {
      console.warn(`⚠️  IA devolvió mensaje vacío — no se envía nada | Expediente: ${nexp}`);
      conversationManager.recordResponse(waId);
      return;
    }
    const result = await adapter.sendText(waId, respuestaIA.mensaje_para_usuario);
    console.log(`✅ Enviado (msgId: ${result?.messageId}) | Expediente: ${nexp} | Entendido: ${respuestaIA.mensaje_entendido}`);

    conversationManager.recordResponse(waId);

    // No cerramos aquí: stage "finalizado" permite una última respuesta segura
    // si el usuario vuelve a escribir. El paso a "cerrado" se hace en canProcess.

  } catch (error) {
    console.error('❌ Error crítico en processMessage:', error);
  }
}

module.exports = { processMessage };
