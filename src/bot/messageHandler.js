// src/bot/messageHandler.js — v6
// Flujo completo con persistencia de JSON por siniestro (data/siniestros/{nexp}.json)
//
// Importante: Solo el primer contacto va por plantilla (sendInitialMessage.js).
// El resto de mensajes se envían como texto generado por IA (Gemini), y el asegurado responde escribiendo.
//
// Paso 1: Verificar datos del siniestro con el asegurado
// Paso 2: Clasificar causa → decidir presencial o pedir horquilla/importe de daños
// Paso 3: IA decide urgencia (silencioso)
// Paso 4: Mensaje final
//
const conversationManager = require('./conversationManager');
const siniestroStore = require('./siniestroStore');
const responses = require('./responses');
const { analyzeUrgency, generateResponse } = require('../ai/aiModel');

// ── Configuración ────────────────────────────────────────────────────────
const DAMAGE_THRESHOLD = Number(process.env.DAMAGE_THRESHOLD || 5000);
const MAX_MISUNDERSTAND = Number(process.env.MAX_MISUNDERSTAND_ATTEMPTS || 2);

// Causas que OBLIGAN visita presencial (según requisito)
function isPresencialOnlyByCause(causaRaw) {
  const c = String(causaRaw || '').toLowerCase();

  // Sobretensión por compañía de la luz
  const sobretension = c.includes('sobretensión') || c.includes('sobretension');
  const companiaLuz = /(compa[nñ]i?a|compania|luz|compa[nñ]ia de la luz)/i.test(c);
  if (sobretension && companiaLuz) return { yes: true, motivo: 'Sobretensión por compañía de la luz' };

  // Robo con sustracción (o robo/hurto/expoliación/sustracción)
  if (/(robo|hurto|expoliaci[oó]n|sustracci[oó]n)/i.test(c)) {
    return { yes: true, motivo: 'Robo / Hurto / Expoliación / Sustracción' };
  }

  // RC / Responsabilidad civil
  if (/\brc\b/i.test(c) || /responsabilidad\s+civil/i.test(c)) {
    return { yes: true, motivo: 'Responsabilidad civil (RC)' };
  }

  // Lesiones
  if (/lesion/i.test(c)) {
    return { yes: true, motivo: 'Lesiones' };
  }

  return { yes: false, motivo: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════
async function processMessage(incomingMessage, senderNumber) {
  let conv = conversationManager.getConversation(senderNumber);

  if (!conv) {
    conv = conversationManager.createOrUpdateConversation(senderNumber, {
      stage: 'consent',
      status: 'new',
      userData: {},
      attempts: 0,
      misunderstandCount: 0,
      history: [],
    });
  }

  const msg = (incomingMessage || '').trim();
  const msgLower = msg.toLowerCase();
  const nexp = conv.userData?.nexp || null;

  console.log('\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`┃ 📬 Mensaje: "${msg}"`);
  console.log(`┃ 📊 Stage: ${conv.stage} | Nexp: ${nexp || '—'}`);
  console.log(`┃ 👤 ${senderNumber}`);
  console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  conversationManager.recordUserMessage(senderNumber);

  // ── Quiere hablar con humano (aplica en cualquier stage) ──
  if (wantsHuman(msgLower)) {
    return doEscalate(senderNumber, conv, msg, 'Usuario solicitó hablar con un perito/persona');
  }

  // ── Router por stage ──
  switch (conv.stage) {
    case 'consent':
      return handleConsent(msg, msgLower, senderNumber, conv);

    case 'verify_data':
      return handleVerifyData(msg, msgLower, senderNumber, conv);

    case 'correct_data':
      return handleCorrectData(msg, msgLower, senderNumber, conv);

    case 'classify_cause':
      return doClassifyCause(senderNumber, conv);

    case 'estimate_damage':
      return handleEstimateDamage(msg, msgLower, senderNumber, conv);

    case 'completed':
    case 'farewell':
    case 'closed':
      return responses.conversacionFinalizada;

    case 'escalated':
      return responses.yaEscalado;

    default:
      console.warn('⚠️  Stage desconocido:', conv.stage);
      return doEscalate(senderNumber, conv, msg, 'Stage desconocido');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PASO 1 — VERIFICAR DATOS
// ═══════════════════════════════════════════════════════════════════════════
async function handleConsent(msg, msgLower, senderNumber, conv) {
  const nexp = conv.userData?.nexp;

  // ✅ Datos correctos
  if (isAffirmative(msgLower)) {
    logRespuesta(nexp, 'consent', 'Verificación de datos', msg);
    persistSiniestro(nexp, { datos_verificados: true, estado: 'en_curso' });
    saveConv(senderNumber, { stage: 'classify_cause', misunderstandCount: 0 }, msg);
    return doClassifyCause(senderNumber, conv);
  }

  // ❌ Datos incorrectos
  if (wantsCorrection(msgLower)) {
    logRespuesta(nexp, 'consent', 'Verificación de datos', msg);
    persistSiniestro(nexp, { datos_verificados: false, estado: 'en_curso' });
    saveConv(senderNumber, { stage: 'correct_data', misunderstandCount: 0 }, msg);
    return aiText('pedirDatosCorregidos', conv.userData);
  }

  // 🚫 No es el asegurado
  if (notInsured(msgLower)) {
    logRespuesta(nexp, 'consent', 'Verificación de datos', msg);
    persistSiniestro(nexp, { estado: 'cerrado_no_asegurado' });
    saveConv(senderNumber, { stage: 'closed', status: 'closed' }, msg);
    return aiText('noEsAsegurado', conv.userData);
  }

  // 🤷 No entendemos
  return doMisunderstand(senderNumber, conv, msg, await aiText('reformularConsent', conv.userData));
}

async function handleVerifyData(msg, msgLower, senderNumber, conv) {
  const nexp = conv.userData?.nexp;

  if (isAffirmative(msgLower)) {
    logRespuesta(nexp, 'verify_data', 'Re-verificación tras corrección', msg);
    persistSiniestro(nexp, { datos_verificados: true, estado: 'en_curso' });
    saveConv(senderNumber, { stage: 'classify_cause', misunderstandCount: 0 }, msg);
    return doClassifyCause(senderNumber, conv);
  }

  if (isNegative(msgLower) || wantsCorrection(msgLower)) {
    logRespuesta(nexp, 'verify_data', 'Re-verificación tras corrección', msg);
    saveConv(senderNumber, { stage: 'correct_data', misunderstandCount: 0 }, msg);
    return aiText('pedirDatosCorregidos', conv.userData);
  }

  return doMisunderstand(senderNumber, conv, msg, await aiText('reformularVerify', conv.userData));
}

async function handleCorrectData(msg, msgLower, senderNumber, conv) {
  const nexp = conv.userData?.nexp;
  const corrections = parseCorrections(msg);
  const userData = { ...(conv.userData || {}), ...corrections };

  // Guardar correcciones
  logRespuesta(nexp, 'correct_data', 'Corrección de datos', msg);

  // Actualizamos también los campos principales del JSON (para que queden consistentes)
  persistSiniestro(nexp, {
    datos_corregidos: corrections,
    nexp: userData.nexp || nexp,
    fecha_siniestro: userData.fecha || userData.fecha_siniestro,
    causa: userData.causa,
    aseguradora: userData.aseguradora,
    telefono: userData.telefono,
    nombre: userData.nombre,
  });

  // Pedimos re-verificación
  saveConv(senderNumber, { stage: 'verify_data', userData, misunderstandCount: 0 }, msg);

  const resumen = buildDataSummary(userData);
  return aiText('confirmarDatosCorregidos', { ...userData, resumen });
}

// ═══════════════════════════════════════════════════════════════════════════
// PASO 2 — CLASIFICAR CAUSA
// ═══════════════════════════════════════════════════════════════════════════
async function doClassifyCause(senderNumber, conv) {
  const freshConv = conversationManager.getConversation(senderNumber) || conv;
  const causaRaw = freshConv.userData?.causa || '';
  const nexp = freshConv.userData?.nexp;

  console.log(`🔍 Clasificando causa: "${String(causaRaw)}"`);

  const { yes: presencialOnly, motivo } = isPresencialOnlyByCause(causaRaw);

  if (presencialOnly) {
    console.log('🏠 → Presencial obligatoria por tipo de causa');

    // Paso 3: urgencia silenciosa
    const urgency = await analyzeUrgency(freshConv.userData || {});

    persistSiniestro(nexp, {
      tipo_visita: 'presencial',
      motivo_tipo_visita: 'Causa requiere visita presencial',
      estimacion_danos: null,
      urgencia: {
        urgente: urgency.urgente,
        motivo: urgency.motivo,
      },
      estado: 'completado',
      completado_at: new Date().toISOString(),
      clasificacion: { motivo_presencial: motivo || 'Causa requiere visita presencial' },
    });

    saveConv(senderNumber, { stage: 'completed', status: 'completed' }, '[AUTO_PRESENCIAL]');
    return aiText('finalPresencialPorCausa', freshConv.userData);
  }

  // No es presencial obligatoria → pedir estimación/horquilla
  console.log('💰 → Pedir estimación de daños');

  saveConv(senderNumber, { stage: 'estimate_damage', misunderstandCount: 0 }, '[AUTO]');
  return aiText('pedirEstimacionDanos', freshConv.userData);
}

// ═══════════════════════════════════════════════════════════════════════════
// PASO 2b — ESTIMACIÓN DE DAÑOS → DIGITAL o PRESENCIAL
// ═══════════════════════════════════════════════════════════════════════════
async function handleEstimateDamage(msg, msgLower, senderNumber, conv) {
  const estimate = extractDamageEstimate(msg);
  const nexp = conv.userData?.nexp;

  if (!estimate) {
    return doMisunderstand(senderNumber, conv, msg, await aiText('reformularEstimacion', conv.userData));
  }

  logRespuesta(nexp, 'estimate_damage', 'Estimación de daños económicos', msg);

  // Para el umbral usamos una referencia conservadora: si es rango, el máximo; si es importe, el importe.
  const reference = estimate.tipo === 'rango' ? estimate.max : estimate.importe;
  const isPresencial = reference > DAMAGE_THRESHOLD;
  const tipoVisita = isPresencial ? 'presencial' : 'digital';

  console.log(`💰 Estimación: ref=${reference}€ (umbral: ${DAMAGE_THRESHOLD}€) → ${tipoVisita.toUpperCase()}`);

  const freshConv = conversationManager.getConversation(senderNumber) || conv;

  // Paso 3: urgencia silenciosa
  const urgency = await analyzeUrgency({ ...(freshConv.userData || {}), estimacion_danos: estimate });

  // Persistimos estimación con formato “horquilla”
  const estimacion_danos =
    estimate.tipo === 'rango'
      ? {
          tipo: 'rango',
          min: estimate.min,
          max: estimate.max,
          referencia: reference,
          respuesta_original: msg,
          umbral: DAMAGE_THRESHOLD,
          supera_umbral: isPresencial,
        }
      : {
          tipo: 'importe',
          referencia: reference,
          importe: estimate.importe,
          respuesta_original: msg,
          umbral: DAMAGE_THRESHOLD,
          supera_umbral: isPresencial,
        };

  persistSiniestro(nexp, {
    estimacion_danos,
    tipo_visita: tipoVisita,
    motivo_tipo_visita: isPresencial
      ? `Estimación supera ${DAMAGE_THRESHOLD}€`
      : `Estimación no supera ${DAMAGE_THRESHOLD}€ — cita digital posible`,
    urgencia: { urgente: urgency.urgente, motivo: urgency.motivo },
    estado: 'completado',
    completado_at: new Date().toISOString(),
  });

  saveConv(senderNumber, { stage: 'completed', status: 'completed', misunderstandCount: 0 }, msg);

  // Paso 4: Mensaje final
  if (isPresencial) return aiText('finalPresencialPorImporte', { ...freshConv.userData, estimacion_danos });
  return aiText('finalDigital', { ...freshConv.userData, estimacion_danos });
}

// ═══════════════════════════════════════════════════════════════════════════
// ESCALACIÓN
// ═══════════════════════════════════════════════════════════════════════════
function doEscalate(senderNumber, conv, msg, reason) {
  console.log(`🚨 Escalando: ${reason}`);
  const nexp = conv.userData?.nexp;

  logRespuesta(nexp, conv.stage, 'Escalación', msg);
  persistSiniestro(nexp, {
    estado: 'escalado',
    escalacion: {
      motivo: reason,
      stage_al_escalar: conv.stage,
      escalado_at: new Date().toISOString(),
    },
  });

  saveConv(
    senderNumber,
    {
      stage: 'escalated',
      status: 'escalated',
      escalatedAt: Date.now(),
      escalationReason: reason,
    },
    msg
  );

  return aiText('escalacion', conv.userData);
}

// ═══════════════════════════════════════════════════════════════════════════
// NO ENTENDEMOS → REINTENTAR o ESCALAR
// ═══════════════════════════════════════════════════════════════════════════
async function doMisunderstand(senderNumber, conv, msg, retryMessage) {
  const count = (conv.misunderstandCount || 0) + 1;

  if (count >= MAX_MISUNDERSTAND) {
    return doEscalate(senderNumber, conv, msg, `No se pudo entender al usuario tras ${count} intentos`);
  }

  const nexp = conv.userData?.nexp;
  logRespuesta(nexp, conv.stage, 'Mensaje no entendido', msg);

  saveConv(senderNumber, { misunderstandCount: count }, msg);
  return retryMessage;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS DE PERSISTENCIA
// ═══════════════════════════════════════════════════════════════════════════
function persistSiniestro(nexp, data) {
  if (!nexp) return;
  siniestroStore.update(nexp, data);
}

function logRespuesta(nexp, stage, pregunta, respuesta) {
  if (!nexp) return;
  siniestroStore.addRespuesta(nexp, stage, pregunta, respuesta);
}

function saveConv(senderNumber, updates, userMsg) {
  const conv = conversationManager.getConversation(senderNumber) || {};
  const history = conv.history || [];

  if (userMsg && userMsg !== '[AUTO]' && !String(userMsg).startsWith('[AUTO_')) {
    history.push({ role: 'user', content: userMsg, timestamp: Date.now() });
  }

  conversationManager.createOrUpdateConversation(senderNumber, {
    ...updates,
    history: history.slice(-30),
    lastResponseAt: Date.now(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// IA: generación de textos por stage (con fallback a responses fijos)
// ═══════════════════════════════════════════════════════════════════════════
async function aiText(kind, ctx = {}) {
  const base = {
    nexp: ctx.nexp,
    fecha_siniestro: ctx.fecha || ctx.fecha_siniestro,
    causa: ctx.causa,
    aseguradora: ctx.aseguradora,
    nombre: ctx.nombre,
    telefono: ctx.telefono,
  };

  const prompts = {
    noEsAsegurado: `Redacta un mensaje breve en español disculpándote porque la persona indica que no es el asegurado. Despídete.`,
    pedirDatosCorregidos: `Pide en español que indique qué datos son incorrectos y que los corrija en un solo mensaje. Da un ejemplo con Nombre, Teléfono y Fecha.`,
    confirmarDatosCorregidos: `Confirma los datos actualizados y pregunta si ahora son correctos. Incluye este resumen:\n\n${ctx.resumen || ''}`,
    reformularConsent: `No has entendido. Pide que responda escribiendo: "Sí" (datos correctos), "No" (hay errores) o "No soy el asegurado".`,
    reformularVerify: `Pide confirmar si los datos actualizados son correctos. Que responda escribiendo "Sí" o "No".`,
    pedirEstimacionDanos: `Pide una estimación aproximada de los daños en euros. Indica que puede responder con un importe (ej. 2000) o un rango (ej. 1000-3000).`,
    reformularEstimacion: `No has podido identificar el importe. Pide que lo indique con un número en euros (por ejemplo 3000€ o 1000-3000€).`,
    escalacion: `Indica en español que un perito se pondrá en contacto directamente para continuar, y agradece su paciencia.`,
    finalPresencialPorCausa: `Redacta un mensaje final: agradece la atención, indica que la visita será presencial por el tipo de siniestro y que un perito contactará para concertar cita. Despídete.`,
    finalPresencialPorImporte: `Redacta un mensaje final: agradece la atención, indica que por la estimación de daños la visita será presencial y que un perito contactará para concertar cita. Despídete.`,
    finalDigital: `Redacta un mensaje final: agradece la atención, indica que la gestión puede ser digital (videollamada) y que un perito contactará para concertar cita. Despídete.`,
  };

  const instruction = prompts[kind] || `Redacta un mensaje breve y profesional en español.`;

  const prompt = `Eres un asistente de un gabinete pericial. Tono profesional y cercano. No menciones que eres IA.\n\nContexto del siniestro:\n${JSON.stringify(base, null, 2)}\n\nInstrucción:\n${instruction}\n`;

  try {
    const out = await generateResponse(prompt);
    const t = String(out || '').trim();
    if (t) return t;
  } catch {
    // fallback abajo
  }

  // fallback: respuestas fijas si existen
  switch (kind) {
    case 'noEsAsegurado':
      return responses.noEsAsegurado;
    case 'pedirDatosCorregidos':
      return responses.pedirDatosCorregidos;
    case 'reformularConsent':
      return responses.reformularConsent;
    case 'reformularVerify':
      return responses.reformularVerify;
    case 'pedirEstimacionDanos':
      return responses.pedirEstimacionDanos;
    case 'reformularEstimacion':
      return responses.reformularEstimacion;
    case 'escalacion':
      return responses.escalacion;
    case 'finalPresencialPorCausa':
      return responses.visitaPresencial + '\n\n' + responses.despedida;
    case 'finalPresencialPorImporte':
      return responses.visitaPresencialPorDanos(
        ctx?.estimacion_danos?.referencia || ctx?.estimacion_danos?.importe || DAMAGE_THRESHOLD + 1
      ) + '\n\n' + responses.despedida;
    case 'finalDigital':
      return responses.visitaDigital + '\n\n' + responses.despedida;
    default:
      return responses.ocupado;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES DE TEXTO
// ═══════════════════════════════════════════════════════════════════════════
function isAffirmative(t) {
  t = t.trim();
  return (
    /^(s[ií]|correcto|correctos|son correctos|vale|ok|de acuerdo|afirmativo|claro|exacto|eso es|perfecto|bien|todo bien|todo correcto)$/i.test(t) ||
    /^s[ií],?\s*(son\s+)?correctos?/i.test(t) ||
    /^s[ií],?\s*(est[aá]n?\s+)?bien/i.test(t)
  );
}

function isNegative(t) {
  return /^(no|incorrecto|incorrectos|negativo|mal|están?\s+mal)$/i.test(t.trim());
}

function wantsHuman(t) {
  return /(hablar.*(perito|persona|humano|agente))|(no\s+quiero\s+(hablar\s+con\s+)?(la\s+)?ia)|(prefer?ir[ío]?\s+.*persona)|(quiero\s+.*perito)|(llam[ae].*perito)|(atenci[oó]n\s+humana)|(agente\s+real)/i.test(t);
}

function wantsCorrection(t) {
  return /(no\s+(est[aá]n?|son)\s+correctos?)|(hay\s+.*error)|(est[aá]n?\s+mal)|(corregir)|(cambiar\s+dato)|(no,?\s+hay\s+(un\s+)?error)/i.test(t);
}

function notInsured(t) {
  return /(no\s+soy\s+(el|la)\s+asegurad[oa])|(no\s+es\s+mi\s+seguro)|(n[uú]mero\s+equivocado)|(se\s+(ha\s+)?equivoca)/i.test(t);
}

// Extrae estimación: rango o importe
function extractDamageEstimate(text) {
  const raw = String(text || '');
  const cleaned = raw
    .replace(/\./g, '')      // 5.000 -> 5000
    .replace(/,/g, '.')      // 5,5 -> 5.5
    .replace(/€/g, ' € ')
    .replace(/\s+/g, ' ')
    .trim();

  // Rangos: "entre 1000 y 3000" | "de 1000 a 3000" | "1000-3000"
  let m = cleaned.match(/entre\s+(\d+(?:\.\d+)?)\s+y\s+(\d+(?:\.\d+)?)/i);
  if (!m) m = cleaned.match(/de\s+(\d+(?:\.\d+)?)\s+a\s+(\d+(?:\.\d+)?)/i);
  if (!m) m = cleaned.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);

  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      return { tipo: 'rango', min, max };
    }
  }

  // Importe único: primer número “razonable”
  const one = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:€|euros?|eur)?/i);
  if (one) {
    const n = Number(one[1]);
    if (!Number.isNaN(n)) return { tipo: 'importe', importe: n };
  }

  // Palabras (muy básico)
  const words = {
    'mil': 1000,
    'dos mil': 2000,
    'tres mil': 3000,
    'cuatro mil': 4000,
    'cinco mil': 5000,
    'seis mil': 6000,
    'siete mil': 7000,
    'ocho mil': 8000,
    'nueve mil': 9000,
    'diez mil': 10000,
    'quince mil': 15000,
    'veinte mil': 20000,
  };
  const lower = raw.toLowerCase();
  const sorted = Object.entries(words).sort((a, b) => b[0].length - a[0].length);
  for (const [w, n] of sorted) {
    if (lower.includes(w)) return { tipo: 'importe', importe: n };
  }

  return null;
}

function parseCorrections(text) {
  const out = {};
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);

  for (const l of lines) {
    const m = l.match(/^[-•]?\s*(\w[\w\s]*?)\s*:\s*(.+)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase().trim();
    const v = m[2].trim();

    if (k.startsWith('nom') || k.startsWith('asegurad')) out.nombre = v;
    else if (k.startsWith('tel') || k.startsWith('móvil') || k.startsWith('movil')) out.telefono = v;
    else if (k.includes('exp') || k.includes('encargo') || k.includes('nº') || k.includes('num')) out.nexp = v;
    else if (k.startsWith('fec')) out.fecha = v;
    else if (k.startsWith('caus') || k.includes('siniestro')) out.causa = v;
    else if (k.startsWith('aseguradora') || k.includes('compañ')) out.aseguradora = v;
    else if (k.startsWith('dir') || k.startsWith('calle')) out.direccion = v;
  }

  if (Object.keys(out).length === 0 && text.length > 0) out._texto_libre = text;
  return out;
}

function buildDataSummary(userData) {
  const fields = [
    ['Encargo (Nº Exp.)', userData.nexp],
    ['Fecha siniestro', userData.fecha || userData.fecha_siniestro],
    ['Causa', userData.causa],
    ['Aseguradora', userData.aseguradora],
    ['Teléfono', userData.telefono],
    ['Nombre', userData.nombre],
  ];
  return fields
    .filter(([, v]) => v)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n');
}

module.exports = { processMessage };
