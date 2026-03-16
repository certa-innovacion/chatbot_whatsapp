const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const mammoth = require('mammoth');
const path = require('path');

const PROMPT_PATH = path.join(__dirname, '..', '..', 'docs', 'pront', 'Promp IA Whatsapp.docx');
let instruccionesBase = '';
let client = null;

// ── Gestión de modelos con fallback ──────────────────────────────────────────

const MODEL_RESET_MS = 5 * 60 * 1000; // intentar volver al principal cada 5 min
let activeModelIdx = 0;
let lastSwitchAt = 0;

function getModelList() {
  const primary = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const fallbacks = (process.env.GEMINI_MODEL_FALLBACKS || 'gemini-2.5-flash-lite,gemini-2.5-pro')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
  return [primary, ...fallbacks];
}

function currentModel() {
  const models = getModelList();
  if (activeModelIdx > 0 && Date.now() - lastSwitchAt > MODEL_RESET_MS) {
    activeModelIdx = 0;
    console.log(`🔄 Volviendo al modelo principal: ${models[0]}`);
  }
  return models[activeModelIdx];
}

function getErrorMessage(error) {
  return String(error?.message || '').toLowerCase();
}

function isTransientProviderError(error) {
  const msg = getErrorMessage(error);
  return (
    error?.status === 429 ||
    error?.status === 500 ||
    error?.status === 502 ||
    error?.status === 503 ||
    error?.status === 504 ||
    error?.name === 'AbortError' ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('resource_exhausted') ||
    msg.includes('overloaded') ||
    msg.includes('high demand') ||
    msg.includes('service unavailable') ||
    msg.includes('unavailable') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('rate limit')
  );
}

function isModelRetiredOrUnsupported(error) {
  const msg = getErrorMessage(error);
  return (
    error?.status === 404 ||
    error?.status === 410 ||
    msg.includes('404') ||
    msg.includes('410') ||
    msg.includes('not found') ||
    msg.includes('no longer available') ||
    msg.includes('is not supported') ||
    msg.includes('unsupported') ||
    msg.includes('model not found') ||
    msg.includes('unknown model') ||
    msg.includes('deprecated') ||
    msg.includes('has been discontinued')
  );
}

function isJsonParseError(error) {
  const msg = String(error?.message || '');
  return (
    error instanceof SyntaxError ||
    msg.includes('Unexpected end of JSON input') ||
    msg.includes('Unexpected token') ||
    msg.includes('JSON')
  );
}

function isPromptLogicError(error) {
  const msg = getErrorMessage(error);
  return (
    !isTransientProviderError(error) &&
    !isModelRetiredOrUnsupported(error) &&
    !isJsonParseError(error) &&
    (
      error?.status === 400 ||
      error?.status === 401 ||
      error?.status === 403 ||
      msg.includes('invalid argument') ||
      msg.includes('bad request') ||
      msg.includes('safety') ||
      msg.includes('blocked') ||
      msg.includes('schema') ||
      msg.includes('response schema') ||
      msg.includes('invalid json schema') ||
      msg.includes('prompt') ||
      msg.includes('system instruction') ||
      msg.includes('token limit') ||
      msg.includes('maximum context length') ||
      msg.includes('context length')
    )
  );
}

function isRetryableProviderError(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    isTransientProviderError(error) ||
    error?.name === 'AbortError' ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed')
  );
}

function tryNextModel(reason = 'Modelo saturado') {
  const models = getModelList();
  if (activeModelIdx + 1 < models.length) {
    activeModelIdx++;
    lastSwitchAt = Date.now();
    console.warn(`⚠️  ${reason}. Cambiando a: ${models[activeModelIdx]}`);
    return true;
  }
  console.error('❌ Todos los modelos Gemini están saturados.');
  return false;
}

function parseModelJsonResponse(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new SyntaxError('Respuesta vacía del modelo');

  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(String(fenced[1]).trim());

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
  }

  let lastErr = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new SyntaxError('No se pudo parsear JSON del modelo');
}

const schema = {
  type: SchemaType.OBJECT,
  properties: {
    mensaje_para_usuario: { type: SchemaType.STRING },
    mensaje_entendido: {
      type: SchemaType.BOOLEAN,
      description: 'true si el mensaje tiene sentido, false si es ruido o ininteligible',
    },
    datos_extraidos: {
      type: SchemaType.OBJECT,
      properties: {
        asegurado_confirmado: { type: SchemaType.BOOLEAN },
        nombre_contacto: { type: SchemaType.STRING },
        relacion_contacto: { type: SchemaType.STRING },
        telefono_contacto: { type: SchemaType.STRING },
        importe_estimado: { type: SchemaType.STRING },
        acepta_videollamada: { type: SchemaType.BOOLEAN },
        preferencia_horaria: { type: SchemaType.STRING },
        estado_expediente: {
          type: SchemaType.STRING,
          enum: ['identificacion', 'valoracion', 'agendando', 'finalizado', 'escalado_humano'],
        },
        idioma_conversacion: {
          type: SchemaType.STRING,
          description:
            "Código ISO 639-1 del idioma detectado en los mensajes del usuario (ej: 'es', 'en', 'fr', 'ca', 'eu'). Rellénalo siempre.",
        },
      },
    },
  },
  required: ['mensaje_para_usuario', 'mensaje_entendido', 'datos_extraidos'],
};

async function initIA() {
  if (!instruccionesBase) {
    const result = await mammoth.extractRawText({ path: PROMPT_PATH });
    instruccionesBase = result.value;
  }
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

function buildPromptFinal(valoresExcel) {
  const reglasControl = `
8. NOMBRE DEL ASEGURADO: El nombre exacto del asegurado en este expediente es "${valoresExcel.nombre}". Cuando debas confirmar la identidad del interlocutor, usa EXACTAMENTE este nombre, sin modificarlo ni inventarlo.
   IMPORTANTE: El "expediente" es un número de referencia administrativo (como un código), NO es una persona. Nunca preguntes si alguien tiene relación "con el expediente" — solo puedes preguntar si el interlocutor ES el asegurado (${valoresExcel.nombre}) o qué relación tiene CON ESA PERSONA (familiar, representante, etc.).
9. CAUSA DEL SINIESTRO: La causa registrada en el expediente es "{{causa}}". Si está vacía, dedúcela a partir de las observaciones del expediente: "{{observaciones}}". Usa esa deducción internamente para contextualizar la conversación, pero no la comuniques al asegurado a menos que sea relevante.
10. DATOS CORREGIDOS POR EL ASEGURADO: si el asegurado corrige dirección, causa u otro dato del expediente, da ese dato por válido y actualizado. No vuelvas a pedir confirmación de ese mismo dato en turnos posteriores salvo que quede ambiguo o incompleto.
11. RELACIÓN YA INFORMADA: si el usuario ya indicó su relación con el asegurado, no vuelvas a preguntarla. Pide solo el dato que falte.
11.b CAMPO "relacion_contacto": cuando el usuario responde a la pregunta de relación con el asegurado, rellena este campo con esa relación.
12. ESTIMACIÓN YA INFORMADA: si el usuario ya dio estimación económica, no la vuelvas a solicitar ni reformular.
13. CAMPOS DE CONTACTO PARA "AT. Perito": cuando el asegurado indique quién atenderá al perito, rellena:
   - nombre_contacto: nombre de esa persona.
   - relacion_contacto: relación de esa persona con el asegurado.
   - telefono_contacto: teléfono de esa persona si lo facilita.
14. VIDEOPERITACIÓN: solo explica qué es y cómo funciona si el usuario expresa dudas o lo pide. Si no hay dudas, pregunta directamente disponibilidad (mañana o tarde).
15. FORMATO DE SALIDA: responde siempre en texto plano. Para listas usa líneas con viñetas "•". Nunca uses etiquetas HTML.
16. CAMPO "preferencia_horaria": rellénalo SOLO cuando el asegurado exprese claramente su preferencia horaria para la visita del perito. Usa "mañana" o "tarde". Déjalo vacío ("") si aún no lo ha indicado.
17. CAMPO "estado_expediente": debes rellenarlo en cada respuesta siguiendo estos criterios:
   - "identificacion": mientras estás verificando identidad, datos del siniestro o dirección.
   - "valoracion": cuando estás recogiendo información sobre los daños, estimación económica o idoneidad para videoperitación.
   - "agendando": cuando estás coordinando la preferencia horaria para la visita.
   - "finalizado": SOLO cuando hayas enviado el mensaje de cierre definitivo tras confirmar el resumen final con el asegurado.
   - "escalado_humano": SOLO cuando hayas confirmado expresamente al asegurado que el perito le llamará por petición suya de hablar con una persona, O cuando el asegurado haya rechazado el consentimiento por SEGUNDA VEZ tras haber recibido ya una explicación.
18. IDIOMA: Detecta el idioma de los mensajes del usuario y rellena SIEMPRE el campo "idioma_conversacion" con el código ISO 639-1. Responde SIEMPRE en el idioma del usuario, sin preguntar confirmación.
19. RECHAZO DE CONSENTIMIENTO: Cuando el usuario rechace continuar antes de haber dado consentimiento, envía un breve mensaje de despedida y establece estado_expediente="escalado_humano". No insistas.
20. RESPUESTA NEGATIVA A PREGUNTA DE IDENTIDAD: Si el usuario ya dio consentimiento y responde "no" a la pregunta de si es el asegurado, NO cierres la conversación. Pregunta quién es y qué relación tiene.
`;

  const reglasReplaced = reglasControl
    .replace(/{{causa}}/g, valoresExcel.causa || '')
    .replace(/{{observaciones}}/g, valoresExcel.observaciones || '');

  return (
    instruccionesBase
      .replace(/{{saludo}}/g, valoresExcel.saludo || '')
      .replace(/{{aseguradora}}/g, valoresExcel.aseguradora || '')
      .replace(/{{nexp}}/g, valoresExcel.nexp || '')
      .replace(/{{causa}}/g, valoresExcel.causa || '')
      .replace(/{{direccion}}/g, valoresExcel.direccion || '')
      .replace(/{{cp}}/g, valoresExcel.cp || '')
      .replace(/{{municipio}}/g, valoresExcel.municipio || '') +
    reglasReplaced
  );
}

function normalizeHistory(historial) {
  const validHistory = [...historial];
  while (validHistory.length > 0 && validHistory[0].role === 'model') validHistory.shift();
  return validHistory;
}

function buildUserMessage(contextoExtra, mensajeUsuario) {
  return `${contextoExtra}\n\nUsuario: ${mensajeUsuario}`;
}

async function callGemini({ validHistory, promptFinal, contextoExtra, mensajeUsuario }) {
  const modelName = currentModel();
  console.log(`🤖 Usando modelo Gemini: ${modelName}`);

  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: promptFinal,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: Number(process.env.GEMINI_TEMPERATURE || 0),
    },
  });

  const chat = model.startChat({ history: validHistory });
  const result = await chat.sendMessage(buildUserMessage(contextoExtra, mensajeUsuario));
  return {
    provider: 'gemini',
    model: modelName,
    data: parseModelJsonResponse(result.response.text()),
  };
}

function detectLanguageHint(text) {
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return { code: 'ja', name: 'japonés' };
  if (/[\uAC00-\uD7AF]/.test(text)) return { code: 'ko', name: 'coreano' };
  if (/[\u4E00-\u9FFF]/.test(text)) return { code: 'zh', name: 'chino' };
  if (/[\u0400-\u04FF]/.test(text)) return { code: 'ru', name: 'ruso' };
  if (/[\u0600-\u06FF]/.test(text)) return { code: 'ar', name: 'árabe' };
  if (/[\u0900-\u097F]/.test(text)) return { code: 'hi', name: 'hindi' };
  if (/[\u0370-\u03FF]/.test(text)) return { code: 'el', name: 'griego' };
  return null;
}

async function callOpenAI({ validHistory, promptFinal, contextoExtra, mensajeUsuario }) {
  if (String(process.env.OPENAI_FALLBACK_ENABLED || 'true').toLowerCase() === 'false') {
    throw new Error('Fallback OpenAI desactivado');
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 15000);

  const langHint = detectLanguageHint(mensajeUsuario);
  const languageRule = langHint
    ? `\n\nREGLA ABSOLUTA DE IDIOMA: El usuario ha escrito en ${langHint.name}. Debes responder OBLIGATORIAMENTE en ${langHint.name} en "mensaje_para_usuario". Pon "${langHint.code}" en "idioma_conversacion". No uses ningún otro idioma bajo ninguna circunstancia.`
    : `\n\nREGLA DE IDIOMA: Detecta el idioma del último mensaje del usuario y responde SIEMPRE en ese mismo idioma en "mensaje_para_usuario". Rellena "idioma_conversacion" con su código ISO 639-1.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages = [
      { role: 'system', content: promptFinal + languageRule },
      ...validHistory.map(item => ({
        role: item.role === 'model' ? 'assistant' : item.role,
        content: item.parts?.map(p => p.text).filter(Boolean).join('\n') || '',
      })),
      {
        role: 'user',
        content: `${buildUserMessage(contextoExtra, mensajeUsuario)}

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura:
{
  "mensaje_para_usuario": "string (en el idioma del usuario)",
  "mensaje_entendido": true,
  "datos_extraidos": {
    "asegurado_confirmado": true,
    "nombre_contacto": "",
    "relacion_contacto": "",
    "telefono_contacto": "",
    "importe_estimado": "",
    "acepta_videollamada": false,
    "preferencia_horaria": "",
    "estado_expediente": "identificacion|valoracion|agendando|finalizado|escalado_humano",
    "idioma_conversacion": "<código ISO 639-1 del idioma del usuario>"
  }
}`,
      },
    ];

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages,
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message =
        body?.error?.message ||
        `OpenAI HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }

    const text = body?.choices?.[0]?.message?.content;
    return {
      provider: 'openai',
      model,
      data: parseModelJsonResponse(text),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSafeEscalationResponse() {
  return {
    mensaje_para_usuario: 'El perito se pondrá en contacto con usted, un saludo.',
    mensaje_entendido: true,
    datos_extraidos: { estado_expediente: 'escalado_humano' },
  };
}

async function tryGeminiWithFallbacks({ validHistory, promptFinal, contextoExtra, mensajeUsuario }) {
  const JSON_RETRIES_PER_MODEL = Math.max(
    0,
    Number(process.env.GEMINI_JSON_RETRIES_PER_MODEL || 1)
  );

  const models = getModelList();
  const jsonRetriesByModel = new Map();
  const maxAttempts = Math.max(3, models.length * (JSON_RETRIES_PER_MODEL + 2));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const modelName = currentModel();

    try {
      const result = await callGemini({ validHistory, promptFinal, contextoExtra, mensajeUsuario });
      console.log(`✅ Respuesta OK desde ${result.provider}:${result.model}`);
      return result.data;
    } catch (error) {
      if (isJsonParseError(error)) {
        console.warn(`[IA_ERROR][BAD_JSON][${modelName}] ${error.message}`);
        const usedRetries = jsonRetriesByModel.get(modelName) || 0;
        if (usedRetries < JSON_RETRIES_PER_MODEL) {
          jsonRetriesByModel.set(modelName, usedRetries + 1);
          console.warn(`⚠️ JSON inválido en ${modelName} (${error.message}). Reintento ${usedRetries + 1}/${JSON_RETRIES_PER_MODEL}.`);
          continue;
        }
        console.warn(`⚠️ JSON inválido persistente en ${modelName}. Probando siguiente modelo.`);
        if (!tryNextModel('JSON inválido persistente')) break;
        continue;
      }

      if (isTransientProviderError(error)) {
        console.warn(`[IA_ERROR][TRANSIENT][${modelName}] ${error.message}`);
        console.warn(`⚠️ Error transitorio en ${modelName}: ${error.message}`);
        if (!tryNextModel('Error transitorio del proveedor')) break;
        continue;
      }

      if (isModelRetiredOrUnsupported(error)) {
        console.warn(`[IA_ERROR][UNSUPPORTED_MODEL][${modelName}] ${error.message}`);
        console.warn(`⚠️ Modelo retirado o no soportado (${modelName}): ${error.message}`);
        if (!tryNextModel('Modelo retirado/no soportado')) break;
        continue;
      }

      if (isPromptLogicError(error)) {
        console.error(`[IA_ERROR][PROMPT_LOGIC][${modelName}] ${error.message}`);
        console.error(`❌ Error lógico de prompt/schema en ${modelName}: ${error.message}`);
        break;
      }

      console.error(`❌ Error no clasificado en ${modelName}: ${error.message}`);
      if (!tryNextModel('Error desconocido en el modelo actual')) break;
    }
  }

  return null; // todos los modelos Gemini fallaron
}

async function procesarConIA(historial, mensajeUsuario, contextoExtra, valoresExcel) {
  await initIA();

  const platform = String(process.env.AI_USING_PLATFORM || 'both').toLowerCase();
  const promptFinal = buildPromptFinal(valoresExcel);
  const validHistory = normalizeHistory(historial);
  const callArgs = { validHistory, promptFinal, contextoExtra, mensajeUsuario };

  if (platform === 'gemini') {
    console.log('🔧 [AI_PLATFORM] Usando solo Gemini');
    const data = await tryGeminiWithFallbacks(callArgs);
    if (data) return data;
    console.error('❌ Todos los modelos Gemini fallaron. Escalando.');
    return buildSafeEscalationResponse();
  }

  if (platform === 'openai') {
    console.log('🔧 [AI_PLATFORM] Usando solo OpenAI');
    try {
      const result = await callOpenAI(callArgs);
      console.log(`✅ Respuesta OK desde ${result.provider}:${result.model}`);
      return result.data;
    } catch (error) {
      console.error(`❌ OpenAI falló: ${error.message}. Escalando.`);
      return buildSafeEscalationResponse();
    }
  }

  // both (default)
  console.log('🔧 [AI_PLATFORM] Usando Gemini con fallback a OpenAI');
  const geminiData = await tryGeminiWithFallbacks(callArgs);
  if (geminiData) return geminiData;

  console.warn('⚠️ Todos los Gemini fallaron. Intentando fallback OpenAI...');
  try {
    const result = await callOpenAI(callArgs);
    console.log(`✅ Fallback OK desde ${result.provider}:${result.model}`);
    return result.data;
  } catch (error) {
    console.error(`🚨 También falló OpenAI: ${error.message}`);
    return buildSafeEscalationResponse();
  }
}

module.exports = {
  procesarConIA,
  _test: {
    isJsonParseError,
    parseModelJsonResponse,
    isRetryableProviderError,
    buildSafeEscalationResponse,
  },
};