// index.js — META WHATSAPP API v5
require('dotenv').config({ override: true });
const express = require('express');
const bodyParser = require('body-parser');

const conversationManager = require('./conversationManager');
const siniestroStore = require('./siniestroStore');
const { processMessage } = require('./messageHandler');
const { sendTextMessage, sendTemplateMessage, markMessageAsRead } = require('./sendMessage');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// ── Health ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'WhatsApp Bot Jumar v5', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    gemini: { model: process.env.GEMINI_MODEL || 'n/a', key: !!process.env.GEMINI_API_KEY },
    meta: {
      phoneId: process.env.META_PHONE_NUMBER_ID || 'n/a',
      apiVersion: process.env.META_API_VERSION || 'n/a',
      token: !!process.env.META_ACCESS_TOKEN,
    },
  });
});

// ── Webhook GET: Verificación de Meta ────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook POST: Mensajes entrantes + statuses ──────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    // 1) STATUS UPDATES (sent/delivered/read/failed)
    if (Array.isArray(value.statuses) && value.statuses.length > 0) {
      for (const st of value.statuses) {
        const recipient = st.recipient_id; // teléfono destino (sin +)
        const wamid = st.id;
        const status = st.status; // sent | delivered | read | failed
        const ts = st.timestamp;

        const conv = recipient ? conversationManager.getConversation(recipient) : null;
        const nexp = conv?.userData?.nexp || null;

        console.log(`📡 STATUS [${recipient || '—'}] ${status} → ${wamid}`);

        if (nexp) {
          siniestroStore.updateMensajeStatusById(nexp, wamid, status, {
            status_timestamp: ts,
            errors: st.errors || null,
            conversation: st.conversation || null,
            pricing: st.pricing || null
          });
        }
      }
    }

    // 2) INCOMING MESSAGES
    if (!Array.isArray(value.messages) || value.messages.length === 0) return;

    for (const message of value.messages) {
      const from = message.from;

      // Marcar como leído (sin bloquear)
      markMessageAsRead(message.id).catch(() => {});

      // Extraer texto
      let text = '';
      let detectedType = message.type || 'text';

      if (message.type === 'text') text = message.text.body;
      else if (message.type === 'button') text = message.button.text;
      else if (message.type === 'interactive') {
        const it = message.interactive;
        text = it.type === 'button_reply' ? it.button_reply.title
             : it.type === 'list_reply'   ? it.list_reply.title
             : '';
      }

      if (!text?.trim()) continue;

      console.log(`\n📥 [${from}] "${text}"`);

      // intentar obtener nexp desde la conversación
      const conv = conversationManager.getConversation(from);
      const nexp = conv?.userData?.nexp || null;

      // Persistir IN
      if (nexp) {
        siniestroStore.addMensaje(nexp, {
          direction: 'in',
          type: detectedType,
          from,
          text,
          meta: {
            meta_message_id: message.id,
            raw_type: message.type
          }
        });
      }

      // Procesar
      const reply = await processMessage(text, from);

      // Enviar respuesta (y persistir OUT con wamid)
      if (reply && typeof reply === 'object' && reply.type === 'template') {
        await sendTemplateMessage(from, reply.name, reply.language || 'es', reply.components || [], { nexp });
        console.log(`📤 [${from}] Enviado (template:${reply.name})`);
      } else if (reply && typeof reply === 'string' && reply.length > 0) {
        await sendTextMessage(from, reply, { nexp });
        console.log(`📤 [${from}] Enviado (${reply.length} chars)`);
      }
    }
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
  }
});

// ── Test: enviar mensaje ─────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  try {
    const { to, message, nexp } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Faltan: to, message' });
    const result = await sendTextMessage(to, message, { nexp });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      meta_status: error?.response?.status,
      meta_error: error?.response?.data,
    });
  }
});

// ── Ver JSON de un siniestro por nexp ────────────────────────────────────
app.get('/siniestro/:nexp', (req, res) => {
  const data = siniestroStore.read(req.params.nexp);
  if (!data || !data.nexp) {
    return res.status(404).json({ error: `Siniestro ${req.params.nexp} no encontrado` });
  }
  res.json(data);
});

// ── Listar todos los siniestros ──────────────────────────────────────────
app.get('/siniestros', (req, res) => {
  const all = siniestroStore.listAll();
  res.json(all);
});

// ── Ver conversación por teléfono ────────────────────────────────────────
app.get('/conversation/:phone', (req, res) => {
  const conv = conversationManager.getConversation(req.params.phone);
  if (!conv) return res.status(404).json({ error: 'No encontrada' });
  res.json(conv);
});

// ── Listar conversaciones ────────────────────────────────────────────────
app.get('/conversations', (req, res) => {
  const all = conversationManager.getAllConversations();
  res.json(all.map(c => ({
    phone: c.phoneNumber,
    stage: c.stage,
    status: c.status,
    nombre: c.userData?.nombre,
    nexp: c.userData?.nexp,
  })));
});

// ── Iniciar servidor ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     🤖 WhatsApp Bot Jumar — Gabinete Pericial v5         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`  ✅ Puerto: ${PORT}`);
  console.log(`  🧠 Gemini: ${process.env.GEMINI_MODEL || 'n/a'}`);
  console.log(`  📞 Phone ID: ${process.env.META_PHONE_NUMBER_ID || 'n/a'}`);
  console.log(`  💰 Umbral presencial: ${process.env.DAMAGE_THRESHOLD || 5000}€`);
  console.log(`  📁 JSONs siniestros: ${siniestroStore.SINIESTROS_DIR}`);
  console.log(`  🌐 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`  📋 Siniestros: http://localhost:${PORT}/siniestros`);
  console.log('');
});

process.on('unhandledRejection', (r) => console.error('❌ Unhandled:', r));
process.on('uncaughtException', (e) => { console.error('❌ Uncaught:', e); process.exit(1); });

module.exports = app;
