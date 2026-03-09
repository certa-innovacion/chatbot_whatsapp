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
  const fallbacks = (process.env.GEMINI_MODEL_FALLBACKS || 'gemini-1.5-flash,gemini-1.5-flash-8b')
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
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('overloaded');
}

function tryNextModel() {
  const models = getModelList();
  if (activeModelIdx + 1 < models.length) {
    activeModelIdx++;
    lastSwitchAt = Date.now();
    console.warn(`⚠️  Modelo saturado. Cambiando a: ${models[activeModelIdx]}`);
    return true;
  }
  console.error('❌ Todos los modelos Gemini están saturados.');
  return false;
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
        estado_expediente: { type: SchemaType.STRING, enum: ["identificacion", "valoracion", "agendando", "finalizado", "escalado_humano"] }
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
   - "escalado_humano": SOLO cuando hayas confirmado expresamente al asegurado que el perito le llamará por petición suya de hablar con una persona.
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
  for (let attempt = 0; attempt <= models.length; attempt++) {
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
      return JSON.parse(result.response.text());

    } catch (error) {
      if (isOverloaded(error)) {
        if (!tryNextModel()) break;
        // reintentar con el siguiente modelo
      } else {
        console.error(`❌ Error en Gemini (${modelName}):`, error.message);
        break;
      }
    }
  }

  return {
    mensaje_para_usuario: "Disculpe, no he podido procesar correctamente su último mensaje. ¿Podría repetirlo?",
    mensaje_entendido: false,
    datos_extraidos: { estado_expediente: "identificacion" }
  };
}

module.exports = { procesarConIA };
