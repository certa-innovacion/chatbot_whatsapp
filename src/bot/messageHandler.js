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

function isIdentityRelationPrompt(text) {
  const t = norm(text);
  return (
    (t.includes('esta relacionado con') || t.includes('esta relaciado con') || t.includes('es usted') || t.includes('es el asegurado')) &&
    (t.includes('expediente') || t.includes('entidad indicada') || t.includes('asegurad'))
  );
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
    t.includes('le contactara el perito') ||
    t.includes('para coordinar la visita') ||
    t.includes('para coordinar la inspeccion') ||
    t.includes('para coordinar la inspección')
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

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&accept-language=es`;
    const res = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'BotPericialJumar/1.0' },
    });
    const a = res.data?.address;
    if (!a) return null;

    const road     = a.road || a.pedestrian || a.footway || '';
    const number   = a.house_number || '';
    const cp       = a.postcode || '';
    const city     = a.city || a.town || a.village || a.municipality || '';
    const province = a.province || a.state || '';

    const parts = [
      road && number ? `${road} ${number}` : road,
      cp,
      city,
      province !== city ? province : '',
    ].filter(Boolean);

    return { address: parts.join(', '), cp, city, displayName: res.data.display_name };
  } catch {
    return null;
  }
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
    let text = (messageObj.text || '').trim();
    let locationResolved = false;
    let locationCoords = null;

    // Mensajes de ubicación compartida por WhatsApp
    if (!text && messageObj.type === 'location' && messageObj.location?.latitude) {
      const loc = messageObj.location;
      locationCoords = `${loc.latitude}, ${loc.longitude}`;
      if (loc.address) {
        // Meta ya trae la dirección (negocio/POI seleccionado del mapa)
        text = `${loc.address} (GPS: ${locationCoords})`;
        locationResolved = true;
      } else {
        // Ubicación actual o pin manual: resolver con reverse geocoding
        const geo = await reverseGeocode(loc.latitude, loc.longitude);
        if (geo) {
          text = `${geo.address} (GPS: ${locationCoords})`;
          locationResolved = true;
        } else {
          // Fallback: coordenadas en texto para que la IA lo intente gestionar
          text = `Ubicación GPS: ${locationCoords}`;
          locationResolved = true;
        }
      }
    }

    if (!text) return;
    let stageAplicado = null;

    // Buscar el nexp vinculado a este número
    const nexp = conversationManager.getNexpByWaId(waId);
    if (!nexp) {
      console.log(`⚠️  Número ${waId} sin expediente vinculado — ignorando`);
      return;
    }

    // ── Logger contextual (prefija [nexp] en cada línea) ─────────────────
    const L = {
      log:  (...a) => console.log( `[${nexp}]`, ...a),
      warn: (...a) => console.warn(`[${nexp}]`, ...a),
      err:  (...a) => console.error(`[${nexp}]`, ...a),
    };
    const msgPreview = text.length > 70 ? `${text.slice(0, 70)}…` : text;
    console.log(`\n${'─'.repeat(65)}`);
    console.log(`📨 [${nexp}] "${msgPreview}"`);
    console.log('─'.repeat(65));

    // ── Máquina de estados ───────────────────────────────────────────────
    const conversation = conversationManager.getConversation(waId);
    const stateCheck = canProcess(conversation);
    if (!stateCheck.ok) {
      L.log(`⛔ Bloqueado (${stateCheck.reason}) stage=${conversation?.stage}`);
      if (stateCheck.response) {
        await adapter.sendText(waId, stateCheck.response);
        if (conversation.stage === 'finalizado') {
          conversationManager.createOrUpdateConversation(waId, { stage: 'cerrado' });
        }
      }
      return;
    }

    // Detectar primera respuesta ANTES de registrar actividad
    const isFirstResponse = !conversation.lastUserMessageAt;

    // Registrar actividad (resetea inactivityAttempts y nextReminderAt)
    conversationManager.recordUserMessage(waId);

    // Leer datos del siniestro y mensajes desde Excel
    const userData        = conversation.userData || {};
    const mensajesPrevios = conversationManager.getMensajes(waId);
    const lastOutMsg      = [...mensajesPrevios].reverse().find(m => m?.direction === 'out') || null;
    const lastBotMessage  = lastOutMsg?.text || '';
    const relationFromCurrent = extractRelationship(text);
    const peritoAttendeeContext = isPeritoAttendeePrompt(lastBotMessage) || isPeritoAttendeeMentionInUser(text);
    const identityPromptContext = isIdentityRelationPrompt(lastBotMessage);
    const identityConfirmedNow = identityPromptContext && isAffirmativeAck(text);
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
    if (locationResolved) {
      contextoSistema += `\n[UBICACIÓN GPS]: El usuario ha compartido su ubicación por GPS. La dirección "${text}" fue obtenida automáticamente. Acéptala como la dirección del siniestro sin pedir que la escriba de nuevo.`;
    }
    if (valoresExcel.observaciones) {
      contextoSistema += `\n[OBSERVACIONES DEL EXPEDIENTE]: ${valoresExcel.observaciones}`;
    }
    if (cpInfo) {
      contextoSistema += `\n[CP DETECTADO]: El código postal ${cpInfo.cp} corresponde a ${cpInfo.localidad} (${cpInfo.provincia}). No preguntes la localidad, úsala directamente.`;
    }
    if (conversation.idioma && conversation.idioma !== 'es') {
      contextoSistema += `\n[IDIOMA ACTIVO]: ${conversation.idioma} — Responde SIEMPRE en este idioma, sin excepción.`;
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
    if (identityConfirmedNow) {
      contextoSistema += '\n[CONFIRMACIÓN IDENTIDAD]: El usuario responde afirmativamente a tu pregunta de identidad/relación. Da la identificación por confirmada y avanza al siguiente dato pendiente. PROHIBIDO repetir la misma pregunta de identidad.';
    }

    // ── Llamada a la IA ──────────────────────────────────────────────────
    const respuestaIAraw = await procesarConIA(historial, text, contextoSistema, valoresExcel);
    const respuestaIA = (respuestaIAraw && typeof respuestaIAraw === 'object') ? respuestaIAraw : {};
    if (!respuestaIA.datos_extraidos || typeof respuestaIA.datos_extraidos !== 'object') {
      respuestaIA.datos_extraidos = {};
    }
    const aiMessage = String(respuestaIA?.mensaje_para_usuario || '').trim();
    if (!aiMessage) {
      // Evita silencios cuando el modelo devuelve JSON válido pero mensaje vacío.
      respuestaIA.mensaje_para_usuario = 'Perdón, no he podido procesar bien su mensaje. ¿Puede repetirlo, por favor?';
      L.warn(`⚠️  IA devolvió mensaje vacío — se envía fallback de recuperación`);
    } else {
      // Normalizamos espacios para comparación/almacenado consistente.
      respuestaIA.mensaje_para_usuario = aiMessage;
    }
    if (
      identityConfirmedNow &&
      lastOutMsg &&
      lastOutMsg.text === respuestaIA.mensaje_para_usuario
    ) {
      respuestaIA.mensaje_para_usuario = 'Perfecto, gracias. Para continuar, indíqueme por favor su nombre y su relación con la persona asegurada.';
      respuestaIA.datos_extraidos.estado_expediente = 'identificacion';
      L.warn(`⚠️  Bucle de identificación detectado tras "sí" del usuario — se fuerza avance de la conversación`);
    }

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
        idioma_conversacion,
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

      // Actualizar AT. Perito:
      // - Si el bot preguntó explícitamente por el asistente al perito → siempre actualizar.
      // - Si no (peritoAttendeeContext=false) → guardar el nombre del interlocutor como
      //   valor inicial de AT. Perito, pero SOLO si aún no hay ninguno registrado.
      //   Así el nombre se captura aunque la conversación no llegue a la fase de agendado.
      const attPeritoActual = String(conversation.attPerito || '').trim();
      const attPeritoVacio  = !attPeritoActual || attPeritoActual.startsWith('sin indicar');
      const shouldUpdateAttPerito =
        (peritoAttendeeContext && Boolean(nombre_contacto || relacion_contacto || relationFromCurrent || telefono_contacto)) ||
        (!peritoAttendeeContext && attPeritoVacio && Boolean(nombre_contacto));
      if (shouldUpdateAttPerito) {
        const [exNombre = '', exRelacion = '', exTelefono = ''] = attPeritoActual.split(' - ');
        const nombreAtt = String(nombre_contacto || '').trim() || (exNombre !== 'sin indicar' ? exNombre : '') || 'sin indicar';
        const relacionAtt = String(relacion_contacto || relationFromCurrent || '').trim() || (exRelacion !== 'sin indicar' ? exRelacion : '') || 'sin indicar';
        const telefonoAtt = normalizeContactPhone(telefono_contacto) || normalizeContactPhone(exTelefono) || normalizeContactPhone(waId);
        excelUpdates.attPerito = `${nombreAtt} - ${relacionAtt} - ${telefonoAtt}`;
      }
      if (idioma_conversacion && idioma_conversacion !== 'es') {
        excelUpdates.idioma = idioma_conversacion;
      }
      if (importe_estimado || estimateFromCurrent) {
        excelUpdates.danos = String(importe_estimado || estimateFromCurrent).trim();
      }
      if (typeof acepta_videollamada === 'boolean') {
        excelUpdates.digital = acepta_videollamada ? 'Sí' : 'No';
      }
      if (preferencia_horaria === 'mañana') excelUpdates.horario = 'Mañana';
      else if (preferencia_horaria === 'tarde') excelUpdates.horario = 'Tarde';
      if (locationCoords) excelUpdates.coordenadas = locationCoords;

      const nuevoStage = ESTADO_IA_TO_STAGE[estado_expediente];
      if (nuevoStage) {
        if (nuevoStage === 'finalizado' && !isDefinitiveClosingMessage(respuestaIA.mensaje_para_usuario)) {
          L.warn(`⚠️  IA marcó "finalizado" sin despedida explícita; no se cierra aún`);
        } else {
          stageAplicado = nuevoStage;
          excelUpdates.stage = nuevoStage;
          excelUpdates.contacto = 'Sí'; // Conversación terminada con el asegurado
          L.log(`🔄 Stage → ${nuevoStage}`);
        }
      }

      conversationManager.createOrUpdateConversation(waId, excelUpdates);

      // Primera respuesta del usuario → asignar perito + marcar contacto en PeritoLine
      if (isFirstResponse) {
        conversationManager.createOrUpdateConversation(waId, { contacto: 'Sí' });
        triggerEncargoSync(nexp, 'primera_respuesta');
        L.log(`🔗 Primera respuesta → sync PeritoLine iniciado (asignar perito + contacto)`);
      }

      // Disparo al cerrar conversación (principalmente para subir PDF).
      if (!isFirstResponse && excelUpdates.contacto === 'Sí' && (stageAplicado === 'finalizado' || stageAplicado === 'escalated')) {
        const digitalVal = excelUpdates.digital || conversation.digital;
        const horarioVal = String(excelUpdates.horario || conversation.horario || '').trim().toLowerCase();
        let horarioLabel = '';
        if (horarioVal.includes('mañana') || horarioVal.includes('manana')) horarioLabel = 'Mañana';
        else if (horarioVal.includes('tarde')) horarioLabel = 'Tarde';
        let anotacion = '[IA] Digital: sin determinar';
        if (digitalVal === 'Sí') {
          anotacion = horarioLabel ? `[IA] Digital: Sí (${horarioLabel})` : '[IA] Digital: Sí';
        }
        else if (digitalVal === 'No') anotacion = '[IA] Digital: Rechaza';
        triggerEncargoSync(nexp, `stage_${stageAplicado}`, anotacion, false, true);
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
    const respPreview = (respuestaIA.mensaje_para_usuario || '').slice(0, 80);
    L.log(`🤖 IA [${respuestaIA.datos_extraidos?.estado_expediente || '?'}]: "${respPreview}${respPreview.length < (respuestaIA.mensaje_para_usuario || '').length ? '…' : ''}"`);
    // Anti-duplicado de salida: si el bot acaba de enviar ese mismo texto
    // en los últimos 60 s, lo registramos en log pero lo enviamos igualmente
    // para no dejar la conversación en silencio.
    const RESP_DEDUP_MS = 60 * 1000;
    if (
      lastOutMsg &&
      lastOutMsg.text === respuestaIA.mensaje_para_usuario &&
      Date.now() - new Date(lastOutMsg.timestamp).getTime() < RESP_DEDUP_MS
    ) {
      L.warn(`⚠️  Respuesta idéntica al mensaje previo (<60s) — se envía igualmente para evitar silencio`);
    }

    const result = await adapter.sendText(waId, respuestaIA.mensaje_para_usuario);
    L.log(`✅ Enviado (msgId: ${result?.messageId}) | entendido=${respuestaIA.mensaje_entendido}`);

    conversationManager.recordResponse(waId);

    // No cerramos aquí: stage "finalizado" permite una última respuesta segura
    // si el usuario vuelve a escribir. El paso a "cerrado" se hace en canProcess.

  } catch (error) {
    const nexpCtx = conversationManager.getNexpByWaId(waId) || waId;
    console.error(`[${nexpCtx}] ❌ Error crítico en processMessage:`, error);
  }
}

module.exports = {
  processMessage,
  // Exportadas para tests unitarios
  _test: {
    isDefinitiveClosingMessage,
    detectEconomicEstimate,
    normalizeContactPhone,
    isAffirmativeAck,
    isIdentityRelationPrompt,
    extractRelationship,
  },
};
