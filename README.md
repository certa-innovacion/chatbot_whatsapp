# Bot Pericial Jumar

Chatbot conversacional para la gestión de siniestros de seguros. Contacta con los asegurados, verifica datos del expediente y coordina la visita del perito — todo mediante IA (Gemini) con arquitectura preparada para migrar de Telegram a WhatsApp sin tocar la lógica de negocio.

---

## Índice

1. [Arquitectura](#arquitectura)
2. [Requisitos](#requisitos)
3. [Instalación](#instalación)
4. [Configuración (.env)](#configuración-env)
5. [Arranque](#arranque)
6. [Envío de mensajes iniciales](#envío-de-mensajes-iniciales)
7. [Flujo de la conversación](#flujo-de-la-conversación)
8. [Estructura del proyecto](#estructura-del-proyecto)
9. [Seguridad implementada](#seguridad-implementada)
10. [Añadir WhatsApp](#añadir-whatsapp)
11. [Endpoints HTTP](#endpoints-http)

---

## Arquitectura

El proyecto se organiza en tres capas independientes:

```
┌─────────────────────────────────────────────────────────┐
│  CORE  —  lógica de negocio (agnóstica al canal)         │
│  conversationManager · siniestroStore · stateMachine     │
│  dedup · rateLimiter · aiModel                           │
├─────────────────────────────────────────────────────────┤
│  CANAL  —  adaptadores de mensajería                     │
│  telegramAdapter   (activo)                              │
│  whatsappAdapter   (pendiente de implementar)            │
├─────────────────────────────────────────────────────────┤
│  INFRA  —  servidor y schedulers                         │
│  index.js (Express + webhook)                            │
│  inactivityHandler · reminderScheduler                   │
└─────────────────────────────────────────────────────────┘
```

El adaptador de canal implementa una **interfaz universal**:

| Método | Descripción |
|---|---|
| `normalizeIncoming(body)` | Webhook payload → `{ channel, userId, text, timestamp, messageId, contact, from }` |
| `sendText(to, text, opts)` | Envía texto plano, devuelve `{ messageId }` |
| `sendTemplate(to, name, params)` | Template WhatsApp / texto equivalente en Telegram |

---

## Requisitos

- Node.js ≥ 18
- Cuenta de bot en Telegram (`@BotFather`)
- API Key de Google AI Studio (Gemini)
- HTTPS público para el webhook (producción) o ngrok (desarrollo)

---

## Instalación

```bash
git clone <repo>
cd chatbot_ia
npm install
cp .env.example .env   # editar con tus credenciales reales
```

---

## Configuración (.env)

```env
# ── IA ────────────────────────────────────────────────────────────────────
GEMINI_API_KEY=           # API Key de Google AI Studio
GEMINI_MODEL=gemini-2.5-flash
GEMINI_TEMPERATURE=0.0    # 0.0 = más determinístico, 1.0 = más creativo
GEMINI_TOP_P=0.95

# ── Telegram ──────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=       # Token de @BotFather
TELEGRAM_TIMEZONE=Europe/Madrid
WEBHOOK_URL=              # URL HTTPS pública (ej: https://botjumar.com)
STARTUP_SET_WEBHOOK=1     # 0 = no registrar webhook al arrancar

# ── WhatsApp / Meta ───────────────────────────────────────────────────────
META_VERIFY_TOKEN=        # Token de verificación del webhook de Meta

# ── Servidor ─────────────────────────────────────────────────────────────
PORT=3000
HOST=127.0.0.1

# ── Almacenamiento ────────────────────────────────────────────────────────
DATA_DIR=./data
CONVERSATIONS_FILE=./data/conversations.json
EXCEL_PATH=./data/allianz_latest.xlsx

# ── Schedulers ────────────────────────────────────────────────────────────
REMINDER_INTERVAL_HOURS=6        # Tiempo entre recordatorios
MAX_REMINDER_ATTEMPTS=3          # Intentos antes de escalar a humano
SCHEDULER_CHECK_INTERVAL_HOURS=6 # Frecuencia de verificación del scheduler
INACTIVITY_TIMEOUT_HOURS=1       # Silencio antes de enviar mensaje de continuidad
INACTIVITY_SNOOZE_HOURS=6        # Snooze tras mensaje de continuidad

# ── Rate limiting ─────────────────────────────────────────────────────────
RATE_USER_MAX=10          # Mensajes máximos por usuario por ventana
RATE_USER_WIN_MS=60000    # Duración de la ventana por usuario (ms)
RATE_GLOBAL_MAX=60        # Mensajes máximos globales por ventana
RATE_GLOBAL_WIN_MS=60000  # Duración de la ventana global (ms)

# ── Logging ───────────────────────────────────────────────────────────────
# LOG_LEVEL=debug         # Activar logs detallados (solo en dev)
# NODE_ENV=development    # Alternativa para activar debug
```

---

## Arranque

### Producción

```bash
npm start
```

Arranca en `HOST:PORT`, registra el webhook en Telegram y queda a la escucha.

### Desarrollo local con ngrok

```bash
# Todo en un comando: arranca bot + ngrok + registra webhook
npm run webhook:ngrok

# Consultar estado
npm run webhook:ngrok:status

# Detener ngrok y bot
npm run webhook:ngrok:stop
```

### Hot-reload

```bash
npm run dev    # nodemon, reinicia al guardar archivos
```

---

## Envío de mensajes iniciales

Los mensajes iniciales se envían desde el Excel de expedientes (`data/allianz_latest.xlsx`).
El asegurado debe haber hecho `/start` y compartido su teléfono en Telegram previamente.

```bash
# Enviar un expediente concreto
npm run send -- EXP2024001

# Enviar todos los marcados como "OK" en el Excel
npm run send -- --all

# Listar expedientes y estado de vinculación
npm run send -- --list

# Ver mapeo teléfono → chatId
npm run send -- --map

# Vincular manualmente teléfono ↔ chatId
npm run send -- --link 34612345678 123456789
```

---

## Flujo de la conversación

### Stages (máquina de estados)

```
consent → identification → valoracion → agendando → finalizado (terminal)
    └─────────────────────────────────────────────┘
    (cualquier stage puede derivar a)    ──────────► escalated (terminal)
```

| Stage | Descripción |
|---|---|
| `consent` | Usuario confirma continuar por este medio |
| `identification` | Verificamos nombre, dirección y fecha del siniestro |
| `valoracion` | Tipo de visita, urgencia, estimación de daños |
| `agendando` | Coordinamos fecha y hora de la visita pericial |
| `finalizado` | Proceso completado — **terminal, IA bloqueada** |
| `escalated` | Derivado a atención humana — **terminal, IA bloqueada** |

### Pipeline de un mensaje entrante

```
POST /webhook
  1. normalizeIncoming()   → objeto normalizado { channel, userId, text, … }
  2. isDuplicate()         → descarta reintentos del webhook (dedup por messageId)
  3. checkLimit()          → rate limit por usuario y global
  4. Routing:
       "/start"  → registrar usuario + solicitar teléfono
       contacto  → vincular teléfono ↔ chatId
       texto     → processMessage()
  5. canProcess()          → bloquea si stage es terminal, envía respuesta segura
  6. procesarConIA()       → Gemini genera respuesta estructurada en JSON
  7. adapter.sendText()    → envía respuesta al usuario
```

### Schedulers automáticos

| Scheduler | Intervalo | Acción |
|---|---|---|
| Recordatorios | Configurable (default 6h) | Hasta 3 recordatorios; tras el último, escala a humano |
| Inactividad | Cada 1 minuto | Mensaje de continuidad tras `INACTIVITY_TIMEOUT_HOURS` sin respuesta |

---

## Estructura del proyecto

```
chatbot_ia/
├── src/
│   ├── channels/
│   │   └── telegramAdapter.js      # Adaptador de canal Telegram
│   ├── utils/
│   │   ├── logger.js               # Logging seguro sin PII
│   │   └── atomicWrite.js          # Escritura atómica JSON + permisos
│   ├── bot/
│   │   ├── index.js                # Servidor Express + webhook handler
│   │   ├── messageHandler.js       # Procesa mensajes con IA
│   │   ├── conversationManager.js  # Estado de conversaciones (JSON)
│   │   ├── siniestroStore.js       # Persistencia de expedientes (JSON)
│   │   ├── stateMachine.js         # Stages y transiciones válidas
│   │   ├── dedup.js                # Deduplicación por messageId
│   │   ├── rateLimiter.js          # Rate limit por usuario y global
│   │   ├── inactivityHandler.js    # Scheduler de inactividad
│   │   ├── reminderScheduler.js    # Scheduler de recordatorios
│   │   ├── templateSender.js       # Mensaje inicial formateado
│   │   └── sendMessage.js          # Transporte Telegram (bajo nivel)
│   ├── ai/
│   │   └── aiModel.js              # Cliente Gemini con output estructurado
│   └── sendInitialMessage.js       # CLI de envío masivo desde Excel
├── data/
│   ├── conversations.json          # Estado de conversaciones activas
│   ├── phone_chatid_map.json       # Mapeo teléfono ↔ chatId
│   ├── siniestros/                 # Un JSON por expediente
│   └── allianz_latest.xlsx         # Excel fuente de expedientes
├── docs/
│   └── pront/
│       └── Promp IA Whatsapp.docx  # System prompt + plantilla del primer mensaje
├── scripts/
│   └── ngrok_webhook.sh            # Helper para desarrollo con ngrok
└── package.json
```

### Formato de datos persistidos

**`data/conversations.json`**
```json
{
  "123456789": {
    "chatId": "123456789",
    "status": "pending",
    "stage": "identification",
    "attempts": 1,
    "lastUserMessageAt": 1708000000000,
    "nextReminderAt": 1708021600000,
    "userData": { "nexp": "EXP001", "nombre": "…", "telefono": "…" }
  }
}
```

**`data/siniestros/{nexp}.json`**
```json
{
  "nexp": "EXP001",
  "nombre": "…",
  "aseguradora": "Allianz",
  "causa": "Daños por Agua",
  "mensajes": [
    { "direction": "out", "text": "…", "timestamp": "…", "telegram_id": 999 },
    { "direction": "in",  "text": "…", "timestamp": "…" }
  ]
}
```

---

## Seguridad implementada

### Logging sin PII (`src/utils/logger.js`)

```javascript
const log = require('./utils/logger');

log.info('Enviando a 346123456789');        // → "Enviando a 3461***89"
log.info({ telefono, nombre, text });       // campos enmascarados automáticamente
log.debug('payload completo:', body);       // solo visible con LOG_LEVEL=debug
log.maskPhone('346123456789')              // → '3461***89'
log.maskName('María García')              // → 'M**** G****'
log.safeLog(...)                            // alias de log.info
```

| Tipo de campo | Tratamiento automático |
|---|---|
| `telefono`, `phone` | `3461***89` (4 primeros + 2 últimos dígitos) |
| `nombre`, `firstName`, `lastName` | Iniciales + asteriscos (`M**** G****`) |
| `text`, `body`, `payload`, `mensaje` | Truncado a 80 caracteres |
| `Error` en producción | Solo `.message`; stack completo con `LOG_LEVEL=debug` |
| Cuerpos HTTP completos | Solo en `log.debug` (silenciado en producción) |

### Escritura atómica (`src/utils/atomicWrite.js`)

- Escribe a `archivo.PID.tmp` y luego hace `rename()` atómico al destino
- Un crash a mitad de escritura **nunca deja el fichero corrupto**
- Permisos en Linux/WSL: directorios `data/` → `700`, ficheros JSON → `600`

### Deduplicación (`src/bot/dedup.js`)

- Evita procesar dos veces el mismo mensaje si Telegram reintenta el webhook
- Clave: `channel:userId:messageId` con TTL de 10 minutos

### Rate limiting (`src/bot/rateLimiter.js`)

- **Por usuario**: `RATE_USER_MAX` mensajes / `RATE_USER_WIN_MS` (default: 10/min)
- **Global**: `RATE_GLOBAL_MAX` mensajes / `RATE_GLOBAL_WIN_MS` (default: 60/min)
- Si se supera el límite: drop silencioso (no se responde al usuario para no crear bucles)

### Máquina de estados (`src/bot/stateMachine.js`)

- Bloquea la llamada a Gemini si el stage es `finalizado` o `escalated`
- Responde con mensajes predefinidos seguros en lugar de llamar a la IA
- `isValidTransition(from, to)` para validar transiciones antes de persistirlas

---

## Añadir WhatsApp

La arquitectura ya está preparada. Solo hay que:

**1. Crear `src/channels/whatsappAdapter.js`** con la misma interfaz:

```javascript
module.exports = {
  channel: 'whatsapp',

  normalizeIncoming(body) {
    // Parsear payload de Meta Cloud API
    // Devolver { channel, userId, text, timestamp, messageId, contact, from }
  },

  async sendText(to, text, opts = {}) {
    // POST a https://graph.facebook.com/…/messages
    // Devolver { messageId }
  },

  async sendTemplate(to, templateName, params = {}) {
    // Llamar a la API de templates aprobados de WhatsApp
  },
};
```

**2. En `src/bot/index.js`**, sustituir el bloque `TODO` del webhook de WhatsApp:

```javascript
const waAdapter = require('../channels/whatsappAdapter');

// Dentro del handler POST /webhook, donde está el TODO:
const waMsg = waAdapter.normalizeIncoming(req.body);
if (waMsg) {
  if (isDuplicate(waMsg.channel, waMsg.userId, waMsg.messageId)) return;
  if (!checkLimit(waMsg.userId).allowed) return;
  await processMessage(waMsg.userId, waMsg);
}
```

El core (`messageHandler`, `conversationManager`, `stateMachine`, schedulers, `siniestroStore`) **no necesita ningún cambio**.

---

## Endpoints HTTP

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Health check básico (`{ status: "ok" }`) |
| `GET` | `/health` | Estado detallado (modelo IA, tokens configurados) |
| `GET` | `/webhook` | Verificación de Meta/WhatsApp (challenge) |
| `POST` | `/webhook` | Recibe mensajes de Telegram y WhatsApp |
