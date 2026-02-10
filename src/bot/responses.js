// src/bot/responses.js — v5
// Mensajes fijos del bot. Ninguno usa IA para garantizar consistencia.

const responses = {
  // ═══════════════════════════════════════════════════════════════
  // PASO 1: VERIFICACIÓN DE DATOS
  // ═══════════════════════════════════════════════════════════════

  noEsAsegurado: `Disculpe las molestias, lamentamos el error. Un saludo.`,

  pedirDatosCorregidos: `De acuerdo. Por favor, indíquenos los datos que desea corregir en un solo mensaje.

Ejemplo:
- Nombre: Juan Pérez García
- Teléfono: 600123456
- Fecha: 15/01/2026`,

  confirmarDatosCorregidos: (resumen) => `Perfecto. Estos son los datos actualizados:

${resumen}

¿Son correctos ahora?`,

  reformularConsent: `Disculpe, no he entendido su respuesta. Por favor, seleccione una de las opciones o indíquenos:

- "Sí" si los datos son correctos
- "No" si hay algún error en los datos
- "No soy el asegurado" si no es usted la persona indicada`,

  reformularVerify: `¿Podría confirmarme si los datos actualizados son correctos? Responda "Sí" o "No", por favor.`,

  // ═══════════════════════════════════════════════════════════════
  // PASO 2: CLASIFICACIÓN Y ESTIMACIÓN
  // ═══════════════════════════════════════════════════════════════

  pedirEstimacionDanos: `Para poder gestionar su siniestro de la forma más ágil posible, necesitamos que nos indique una estimación aproximada del importe de los daños en euros.

Por ejemplo: "Unos 2000 euros" o "Entre 1000 y 3000 euros".`,

  reformularEstimacion: `Disculpe, no he podido identificar el importe. ¿Podría indicar la estimación de daños con un número? Por ejemplo: "3000 euros".`,

  // Presencial por tipo de causa
  visitaPresencial: `Dado el tipo de siniestro, le informamos de que la visita del perito será de forma presencial. Un perito se pondrá en contacto con usted para concertar una cita.`,

  // Presencial por importe de daños
  visitaPresencialPorDanos: (importe) =>
    `Dado que la estimación de daños es de ${importe.toLocaleString('es-ES')}€, le informamos de que la visita del perito será de forma presencial. Un perito se pondrá en contacto con usted para concertar una cita.`,

  // Digital (importe < umbral y causa no obliga presencial)
  visitaDigital: `Le informamos de que la gestión de su siniestro se realizará de forma digital (videollamada). Un perito se pondrá en contacto con usted para concertar la cita telemática.`,

  // ═══════════════════════════════════════════════════════════════
  // PASO 4: DESPEDIDA
  // ═══════════════════════════════════════════════════════════════

  despedida: `Muchas gracias por su tiempo y colaboración. Que tenga un buen día.`,

  // ═══════════════════════════════════════════════════════════════
  // ESCALACIÓN
  // ═══════════════════════════════════════════════════════════════

  escalacion: `Entendido. Un perito se pondrá en contacto con usted directamente para continuar con la gestión. Disculpe las molestias y gracias por su paciencia.`,

  yaEscalado: `Su caso ya ha sido derivado. Un perito se pondrá en contacto con usted próximamente. Gracias.`,

  // ═══════════════════════════════════════════════════════════════
  // OTROS
  // ═══════════════════════════════════════════════════════════════

  conversacionFinalizada: `Esta conversación ya ha sido finalizada. Si necesita ayuda adicional, por favor contacte con su aseguradora. Gracias.`,

  ocupado: `Sin problema, entendemos que está ocupado/a. Le volveremos a contactar más adelante.`,

  // Recordatorios (usados por reminderScheduler)
  recordatorio1: `Hola, le escribimos de nuevo desde el gabinete pericial. ¿Ha podido revisar el mensaje que le enviamos? Quedamos a la espera de su respuesta. Gracias.`,

  recordatorio2: `Le recordamos que necesitamos su confirmación para poder continuar con la gestión de su siniestro. ¿Podría respondernos cuando le sea posible? Gracias.`,

  recordatorioFinal: `Este es nuestro último recordatorio. Si no recibimos respuesta, un perito se pondrá en contacto con usted directamente por teléfono. Gracias por su comprensión.`,
};

module.exports = responses;