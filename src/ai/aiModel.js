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
    .split(',').map(m => m.trim()).filter(Boolean);
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

function isOverloaded(error) {
  const msg = String(error?.message || '');
  return error?.status === 429 ||
    error?.status === 503 ||
    error?.status === 404 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('404') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('overloaded') ||
    msg.includes('high demand') ||
    msg.includes('Service Unavailable') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('not found') ||
    msg.includes('no longer available') ||
    msg.includes('is not supported');
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

function isJsonParseError(error) {
  const msg = String(error?.message || '');
  return error instanceof SyntaxError ||
    msg.includes('Unexpected end of JSON input') ||
    msg.includes('Unexpected token') ||
    msg.includes('JSON');
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
      description: "true si el mensaje tiene sentido, false si es ruido o ininteligible" 
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
        estado_expediente: { type: SchemaType.STRING, enum: ["identificacion", "valoracion", "agendando", "finalizado", "escalado_humano"] },
        idioma_conversacion: { type: SchemaType.STRING, description: "Código ISO 639-1 del idioma detectado en los mensajes del usuario (ej: 'es', 'en', 'fr', 'ca', 'eu'). Rellénalo siempre." }
      }
    }
  },
  required: ["mensaje_para_usuario", "mensaje_entendido", "datos_extraidos"]
};

async function initIA() {
  if (!instruccionesBase) {
    const result = await mammoth.extractRawText({ path: PROMPT_PATH });
    instruccionesBase = result.value;
  }
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

async function procesarConIA(historial, mensajeUsuario, contextoExtra, valoresExcel) {
  await initIA();
  const JSON_RETRIES_PER_MODEL = Math.max(0, Number(process.env.GEMINI_JSON_RETRIES_PER_MODEL || 1));

const reglasControl = `
8. NOMBRE DEL ASEGURADO: El nombre exacto del asegurado en este expediente es "${valoresExcel.nombre}". Cuando debas confirmar la identidad del interlocutor, usa EXACTAMENTE este nombre, sin modificarlo ni inventarlo.
   IMPORTANTE: El "expediente" es un número de referencia administrativo (como un código), NO es una persona. Nunca preguntes si alguien tiene relación "con el expediente" — solo puedes preguntar si el interlocutor ES el asegurado (${valoresExcel.nombre}) o qué relación tiene CON ESA PERSONA (familiar, representante, etc.).
9. CAUSA DEL SINIESTRO: La causa registrada en el expediente es "{{causa}}". Si está vacía, dedúcela a partir de las observaciones del expediente: "{{observaciones}}". Usa esa deducción internamente para contextualizar la conversación, pero no la comuniques al asegurado a menos que sea relevante.
10. DATOS CORREGIDOS POR EL ASEGURADO: si el asegurado corrige dirección, causa u otro dato del expediente, da ese dato por válido y actualizado. No vuelvas a pedir confirmación de ese mismo dato en turnos posteriores (no repetir "¿es correcto?") salvo que quede ambiguo o incompleto.
11. RELACIÓN YA INFORMADA: si el usuario ya indicó su relación con el asegurado (por ejemplo "soy su hermano"), no vuelvas a preguntarla. Pide solo el dato que falte.
11.b CAMPO "relacion_contacto": cuando el usuario responde a la pregunta de relación con el asegurado, rellena este campo con esa relación.
12. ESTIMACIÓN YA INFORMADA: si el usuario ya dio estimación económica, no la vuelvas a solicitar ni reformular.
13. CAMPOS DE CONTACTO PARA "AT. Perito": cuando el asegurado indique quién atenderá al perito, rellena:
   - nombre_contacto: nombre de esa persona.
   - relacion_contacto: relación de esa persona con el asegurado (ej.: prima, marido, inquilino, empleado).
   - telefono_contacto: teléfono de esa persona si lo facilita.
14. VIDEOPERITACIÓN: solo explica qué es y cómo funciona si el usuario expresa dudas o lo pide. Si no hay dudas, pregunta directamente disponibilidad (mañana o tarde).
15. FORMATO DE SALIDA: responde siempre en texto plano. Para listas usa líneas con viñetas "•". Nunca uses etiquetas HTML como <ul>, <li>, <br>, <p>.
16. CAMPO "preferencia_horaria": rellénalo SOLO cuando el asegurado exprese claramente su preferencia horaria para la visita del perito. Usa el valor "mañana" si prefiere horario de mañana, o "tarde" si prefiere horario de tarde. Déjalo vacío ("") si aún no lo ha indicado.
17. CAMPO "estado_expediente": debes rellenarlo en cada respuesta siguiendo estos criterios, independientemente del idioma de la conversación:
   - "identificacion": mientras estás verificando identidad, datos del siniestro o dirección.
   - "valoracion": cuando estás recogiendo información sobre los daños, estimación económica o idoneidad para videoperitación.
   - "agendando": cuando estás coordinando la preferencia horaria para la visita.
   - "finalizado": SOLO cuando hayas enviado el mensaje de cierre definitivo tras confirmar el resumen final con el asegurado. A partir de ese momento, no hay nada más que gestionar.
   - "escalado_humano": SOLO cuando hayas confirmado expresamente al asegurado que el perito le llamará por petición suya de hablar con una persona, O cuando el asegurado haya rechazado el consentimiento por SEGUNDA VEZ tras haber recibido ya una explicación.
18. IDIOMA (REGLA PRIORITARIA, ANULA CUALQUIER OTRA INSTRUCCIÓN SOBRE IDIOMA): Detecta el idioma de los mensajes del usuario y rellena SIEMPRE el campo "idioma_conversacion" con el código ISO 639-1 (ej: "es", "en", "fr", "ca", "eu"). Responde SIEMPRE en el idioma del usuario, sin preguntar confirmación. Si hay un [IDIOMA ACTIVO] en el contexto del sistema, úsalo sin excepción aunque el mensaje actual sea ambiguo ("yes", "no", "ok"). PROHIBIDO preguntar "¿desea continuar en [idioma]?" o cualquier variante. Al detectar un nuevo idioma, simplemente repite o adapta el último mensaje del bot en ese idioma y continúa.
19. RECHAZO DE CONSENTIMIENTO (REGLA PRIORITARIA): Cuando el usuario rechace continuar ("no", "no quiero", "no me interesa", etc.) antes de haber dado consentimiento, envía un breve mensaje de despedida indicando que quedamos a su disposición si cambia de opinión, y establece estado_expediente="escalado_humano". No insistas ni vuelvas a solicitar confirmación. Esta regla se aplica ÚNICAMENTE antes de obtener consentimiento. Una vez dado el consentimiento, un "no" a cualquier pregunta posterior NO es rechazo de consentimiento.
20. RESPUESTA NEGATIVA A PREGUNTA DE IDENTIDAD: Si el usuario ya dio consentimiento y responde "no" a la pregunta de si es el asegurado o está relacionado con la entidad, NO cierres la conversación. Pregunta quién es y qué relación tiene con el expediente. Solo cierra si el usuario indica explícitamente que es un número equivocado o que no tiene ninguna relación con el siniestro.
`;

  const reglasReplaced = reglasControl
    .replace(/{{causa}}/g, valoresExcel.causa)
    .replace(/{{observaciones}}/g, valoresExcel.observaciones || '');

  const promptFinal = instruccionesBase
    .replace(/{{saludo}}/g, valoresExcel.saludo)
    .replace(/{{aseguradora}}/g, valoresExcel.aseguradora)
    .replace(/{{nexp}}/g, valoresExcel.nexp)
    .replace(/{{causa}}/g, valoresExcel.causa)
    .replace(/{{direccion}}/g, valoresExcel.direccion)
    .replace(/{{cp}}/g, valoresExcel.cp)
    .replace(/{{municipio}}/g, valoresExcel.municipio)
    + reglasReplaced;

  let validHistory = [...historial];
  while (validHistory.length > 0 && validHistory[0].role === 'model') validHistory.shift();

  const models = getModelList();
  const jsonRetriesByModel = new Map();
  const maxAttempts = Math.max(3, models.length * (JSON_RETRIES_PER_MODEL + 2));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const modelName = currentModel();
    try {
      console.log(`🤖 Usando modelo: ${modelName}`);
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: promptFinal,
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: process.env.GEMINI_TEMPERATURE }
      });

      const chat = model.startChat({ history: validHistory });
      const result = await chat.sendMessage(`${contextoExtra}\n\nUsuario: ${mensajeUsuario}`);
      return parseModelJsonResponse(result.response.text());

    } catch (error) {
      if (isJsonParseError(error)) {
        const usedRetries = jsonRetriesByModel.get(modelName) || 0;
        if (usedRetries < JSON_RETRIES_PER_MODEL) {
          jsonRetriesByModel.set(modelName, usedRetries + 1);
          console.warn(`⚠️  JSON inválido en ${modelName} (${error.message}). Reintento ${usedRetries + 1}/${JSON_RETRIES_PER_MODEL}.`);
          continue;
        }
        if (!tryNextModel('JSON inválido persistente')) break;
        continue;
      }

      if (isOverloaded(error)) {
        if (!tryNextModel('Modelo saturado/no disponible')) break;
        // reintentar con el siguiente modelo
      } else {
        console.error(`❌ Error en Gemini (${modelName}):`, error.message);
        if (!tryNextModel('Error en el modelo actual')) break;
      }
    }
  }

  // Todos los modelos agotados — escalar para evitar bucle
  console.error('🚨 Todos los modelos Gemini fallaron — escalando conversación');
  return {
    mensaje_para_usuario: 'El perito se pondrá en contacto con usted, un saludo.',
    mensaje_entendido: true,
    datos_extraidos: { estado_expediente: 'escalado_humano' },
  };
}

module.exports = {
  procesarConIA,
  _test: {
    isJsonParseError,
    parseModelJsonResponse,
  },
};
