# Bot Pericial Jumar

Chatbot conversacional para la gestión de siniestros de seguros. Contacta con los asegurados via WhatsApp, verifica datos del expediente, coordina la visita del perito y sincroniza el encargo con PeritoLine — todo mediante IA (Gemini) integrada con la Meta Cloud API.

---

## Índice

1. [Arquitectura](#arquitectura)
2. [Requisitos](#requisitos)
3. [Instalación](#instalación)
4. [Configuración (.env)](#configuración-env)
5. [Arranque](#arranque)
6. [Envío de mensajes iniciales](#envío-de-mensajes-iniciales)
7. [Flujo de la conversación](#flujo-de-la-conversación)
8. [Almacenamiento de datos](#almacenamiento-de-datos)
9. [PDF de transcripción](#pdf-de-transcripción)
10. [Sincronización con PeritoLine](#sincronización-con-peritoline)
11. [Limpieza automática de datos](#limpieza-automática-de-datos)
12. [Estructura del proyecto](#estructura-del-proyecto)
13. [Seguridad implementada](#seguridad-implementada)
14. [Endpoints HTTP](#endpoints-http)

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│  CORE  —  lógica de negocio                              │
│  conversationManager · stateMachine                      │
│  dedup · rateLimiter · aiModel                           │
├─────────────────────────────────────────────────────────┤
│  CANAL  —  adaptador de mensajería                       │
│  whatsappAdapter   (Meta Cloud API)                      │
├─────────────────────────────────────────────────────────┤
│  INFRA  —  servidor y schedulers                         │
│  index.js (Express + webhook)                            │
│  reminderScheduler · peritolineAutoSync                  │
└─────────────────────────────────────────────────────────┘
```

El adaptador de canal implementa una **interfaz universal**:

| Método | Descripción |
|---|---|
| `normalizeIncoming(body)` | Webhook payload → `{ channel, userId, text, location, timestamp, messageId, type, from }` |
| `sendText(to, text, opts)` | Envía texto plano, devuelve `{ messageId }` |
| `sendTemplate(to, name, params)` | Envía template aprobado de WhatsApp |

`location` solo viene relleno cuando `type === 'location'`: `{ latitude, longitude, name, address }`. El campo `address` solo lo provee Meta cuando el usuario selecciona un negocio/POI; si no, se resuelve con reverse geocoding (Nominatim/OSM).

---

## Requisitos

- Node.js ≥ 18
- Cuenta de Meta for Developers con app de WhatsApp Business
- API Key de Google AI Studio (Gemini)
- HTTPS público para el webhook (producción) o ngrok (desarrollo)
- Playwright instalado (para la sincronización con PeritoLine)

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
GEMINI_MODEL_FALLBACKS=gemini-1.5-flash,gemini-1.5-flash-8b
GEMINI_TEMPERATURE=0.0    # 0.0 = más determinístico, 1.0 = más creativo
GEMINI_TOP_P=0.95
GEMINI_TOP_K=40
GEMINI_MAX_OUTPUT_TOKENS=1000

# ── WhatsApp / Meta ───────────────────────────────────────────────────────
META_VERIFY_TOKEN=        # Token de verificación del webhook de Meta
USER_ACCESS_TOKEN=        # Token de acceso de la app de Meta
VERSION=v25.0
WABA_ID=                  # ID del WhatsApp Business Account
PHONE_NUMBER_ID=          # ID del número de teléfono de WhatsApp Business

# ── Servidor ─────────────────────────────────────────────────────────────
PORT=3000
HOST=127.0.0.1
WEBHOOK_URL=              # URL HTTPS pública (ej: https://botjumar.com)

# ── Almacenamiento ────────────────────────────────────────────────────────
EXCEL_PATH=./data/allianz_latest.xlsx

# ── Schedulers ────────────────────────────────────────────────────────────
SCHEDULER_CHECK_MINUTES=15         # Frecuencia de verificación del scheduler
INITIAL_RETRY_INTERVAL_MINUTES=360 # Intervalo entre reenvíos del template inicial (6h)
INITIAL_RETRY_MAX_ATTEMPTS=3       # Intentos máximos antes de escalar
INACTIVITY_INTERVAL_MINUTES=120    # Intervalo entre mensajes de inactividad (2h)
INACTIVITY_MAX_ATTEMPTS=3          # Recordatorios máximos antes de escalar
BUSINESS_HOURS_START=9             # Hora de inicio de envíos (formato 24h)
BUSINESS_HOURS_END=20              # Hora de fin de envíos
MSG_FINAL_INACTIVIDAD=             # Mensaje a enviar al escalar por inactividad

# ── Rate limiting ─────────────────────────────────────────────────────────
RATE_USER_MAX=10           # Mensajes máximos por usuario por ventana
RATE_USER_WIN_MS=60000     # Duración de la ventana por usuario (ms)
RATE_GLOBAL_MAX=60         # Mensajes máximos globales por ventana
RATE_GLOBAL_WIN_MS=60000   # Duración de la ventana global (ms)

# ── Limpieza de datos ─────────────────────────────────────────────────────
SINIESTRO_CLEANUP_DAYS=7   # Días antes de eliminar filas antiguas del Excel
PDF_CLEANUP_DAYS=7         # Días antes de eliminar PDFs de transcripción

# ── Logging ───────────────────────────────────────────────────────────────
LOG_LEVEL=info             # debug | info | warn | error
AI_DEBUG_LOGS=false        # true = loguea prompts y respuestas completas de Gemini
SAVE_LOGS_TO_FILE=false    # true = escribe también en LOG_FILE_PATH
LOG_FILE_PATH=./logs/bot.log

# ── PeritoLine ────────────────────────────────────────────────────────────
UPLOAD_CONVERSATIONS_TO_PL=true           # Activar sincronización automática
PERITOLINE_AUTO_SYNC=true
PERITOLINE_AUTO_SYNC_COOLDOWN_MS=45000    # Cooldown entre ejecuciones (ms)
PERITOLINE_AUTO_SYNC_HEADLESS=true        # Playwright en modo headless
PERITOLINE_AUTO_SYNC_DRY_RUN=false        # true = prueba sin subir nada
LOGIN_URL=                                 # URL del login de PeritoLine
USERNAME=                                  # Credenciales PeritoLine
PASSWORD=
```

---

## Arranque

### Producción

```bash
npm start
```

Arranca en `HOST:PORT` y queda a la escucha del webhook de WhatsApp.

### Desarrollo local con ngrok

```bash
npm run dev    # nodemon, reinicia al guardar archivos
```

Exponer el puerto con ngrok en otra terminal y configurar la URL en el panel de Meta Developers.

---

## Envío de mensajes iniciales

El script lee el Excel de expedientes (`EXCEL_PATH`) y envía el template de WhatsApp aprobado a cada asegurado pendiente. Registra el estado de cada conversación en la hoja interna `__bot_state` del Excel.

```bash
# Enviar todos los expedientes con Estado="OK"
npm run send

# Enviar un único expediente por número de encargo
npm run send -- --nexp 880337292

# Enviar a un número de teléfono concreto
npm run send -- --tel 674742564

# Simular sin enviar nada (dry run)
npm run send -- --dry-run
```

Cada envío inicializa la conversación en `stage=consent`, `attempts=0`, `contacto="En curso"` y activa el scheduler de recordatorios automáticos (Escenario A).

---

## Flujo de la conversación

### Stages (máquina de estados)

```
consent → identification → valoracion → agendando → finalizado → cerrado (terminal)
    └─────────────────────────────────────────────────────────┘
    (cualquier stage puede derivar a)    ──────────────────────► escalated (terminal)
```

| Stage | Descripción |
|---|---|
| `consent` | El asegurado confirma continuar por este medio |
| `identification` | Verificación de nombre, dirección y causa del siniestro |
| `valoracion` | Daños, estimación económica, aceptación de videoperitación, persona de contacto para el perito |
| `agendando` | Preferencia horaria para la visita (mañana/tarde) |
| `finalizado` | La IA envía el resumen final con todos los datos recogidos |
| `cerrado` | Silencio total — **terminal, IA bloqueada** |
| `escalated` | Derivado a atención humana — **terminal, IA bloqueada** |

### Tipos de mensaje soportados

| Tipo WhatsApp | Tratamiento |
|---|---|
| `text` | Procesado directamente por la IA |
| `location` | Coordenadas → reverse geocoding (Nominatim/OSM) → dirección en texto → IA |
| Resto (`audio`, `image`, etc.) | Respuesta informativa, no se procesa |

### Pipeline de un mensaje entrante

```
POST /webhook
  1. normalizeIncoming()   → objeto normalizado { channel, userId, text, location, type, … }
  2. Filtro de tipo        → pasa 'text' y 'location'; resto → respuesta informativa
  3. isDuplicate()         → descarta reintentos del webhook (dedup por messageId)
  4. checkLimit()          → rate limit por usuario y global
  5. processMessage()
       si type='location'  → reverseGeocode(lat, lon) → dirección en texto
  6. canProcess()          → bloquea si stage es terminal, envía respuesta segura
  7. procesarConIA()       → Gemini genera respuesta estructurada en JSON
  8. excelManager          → actualiza columnas de negocio en el Excel
  9. adapter.sendText()    → envía respuesta al usuario por WhatsApp
 10. peritolineAutoSync    → si conversación terminada, dispara sync asíncrono
 11. pdfGenerator          → si conversación terminada, genera PDF de transcripción
```

### Respuesta estructurada de la IA

Gemini devuelve siempre un objeto JSON con este esquema:

```json
{
  "mensaje_para_usuario": "Texto que se envía al asegurado",
  "mensaje_entendido": true,
  "datos_extraidos": {
    "asegurado_confirmado": true,
    "nombre_contacto": "Nombre del interlocutor",
    "relacion_contacto": "hijo",
    "telefono_contacto": "34674000000",
    "importe_estimado": "1500 €",
    "acepta_videollamada": true,
    "preferencia_horaria": "mañana",
    "estado_expediente": "valoracion | agendando | finalizado | escalado_humano"
  }
}
```

### Schedulers automáticos

El scheduler corre cada `SCHEDULER_CHECK_MINUTES` (15 min) y solo envía mensajes en horario laboral (L-V `BUSINESS_HOURS_START`-`BUSINESS_HOURS_END`). Las tareas de limpieza se ejecutan siempre sin restricción horaria.

| Escenario | Condición | Acción | Límite |
|---|---|---|---|
| **A — Sin respuesta inicial** | `lastUserMessageAt` es null | Reenvío del template inicial | `INITIAL_RETRY_MAX_ATTEMPTS` (3) |
| **B — Inactividad mid-conv** | `lastUserMessageAt` existe y `now > nextReminderAt` | Mensaje de inactividad vía IA | `INACTIVITY_MAX_ATTEMPTS` (3) |
| **Escalado** | Se supera el límite en cualquier escenario | Envía `MSG_FINAL_INACTIVIDAD`, marca `contacto=No`, activa PeritoLine sync y genera PDF | — |

---

## Almacenamiento de datos

Todo el estado del bot vive en el **mismo archivo Excel** (`data/allianz_latest.xlsx`), en dos capas:

### Capa 1 — Datos de negocio (hoja principal)

Gestionada por el equipo de Jumar. El bot lee estos campos y escribe el resultado de la conversación:

| Columna | Tipo | Descripción |
|---|---|---|
| `Encargo` | Lectura | Número de expediente |
| `Asegurado` | Lectura | Nombre del titular |
| `Aseguradora` | Lectura | Nombre de la aseguradora |
| `Causa` | Lectura | Causa del siniestro |
| `Observaciones` | Lectura | Notas internas del expediente |
| `Teléfono` | Lectura | Número WhatsApp del asegurado |
| `Dirección`, `CP`, `Municipio` | Lectura | Dirección del siniestro |
| `Contacto` | **Escritura** | `En curso` / `Sí` / `No` |
| `Relación` | **Escritura** | Relación del interlocutor con el asegurado |
| `AT. Perito` | **Escritura** | Persona que atiende al perito (`nombre - relación - teléfono`) |
| `Daños` | **Escritura** | Estimación económica de los daños |
| `Digital` | **Escritura** | Acepta videoperitación (`Sí` / `No`) |
| `Horario` | **Escritura** | Preferencia horaria (`Mañana` / `Tarde`) |

### Capa 2 — Estado técnico (hoja `__bot_state`)

Gestionada exclusivamente por el bot. Persiste el estado entre reinicios:

| Campo | Descripción |
|---|---|
| `waId` | Número de WhatsApp (sin +) |
| `status` | `pending` / `escalated` |
| `stage` | Stage actual de la conversación |
| `attempts` | Reenvíos del template inicial |
| `inactivityAttempts` | Recordatorios de inactividad enviados |
| `nextReminderAt` | Timestamp Unix del próximo scheduler |
| `lastUserMessageAt` | Último mensaje entrante del usuario |
| `lastReminderAt` | Último recordatorio enviado |
| `lastMessageAt` | Última actividad (entrada o salida) |
| `mensajes` | JSON array con el historial completo de la conversación |

---

## PDF de transcripción

Al finalizar una conversación (`stage=finalizado` o `stage=escalated`), el bot genera automáticamente un PDF en `docs/conversations/conversation_[nexp].pdf`.

**Contenido del PDF:**

- Cabecera institucional con logotipo de Jumar
- Datos del expediente: nexp, asegurado, aseguradora, dirección, causa
- Datos recogidos en la conversación: estimación de daños, videoperitación, horario, AT. Perito
- Historial completo de mensajes con timestamps y autor (bot / asegurado)
- Pie con fecha y hora de generación

Los PDFs se eliminan automáticamente a los `PDF_CLEANUP_DAYS` días (ver [Limpieza automática](#limpieza-automática-de-datos)).

**Generación manual:**

```javascript
const { generateConversationPdf } = require('./src/utils/pdfGenerator');
await generateConversationPdf(nexp, userData, mensajes, { stage, contacto, attPerito, danos, digital, horario });
```

---

## Sincronización con PeritoLine

Cuando una conversación termina (`stage=finalizado` o `stage=escalated`) el bot dispara automáticamente una sincronización asíncrona con PeritoLine mediante un proceso hijo que no bloquea el hilo principal.

**Flujo:**

1. `triggerEncargoSync(nexp, reason)` comprueba el cooldown (`PERITOLINE_AUTO_SYNC_COOLDOWN_MS`) y que no haya ya una ejecución en curso para ese nexp
2. Lanza `scripts/peritoline_sync.js --encargo [nexp]` como child process (`child.unref()`)
3. Playwright abre el navegador (headless) y sube los datos del expediente a PeritoLine
4. Loguea el resultado; si falla, no afecta al bot

**Variables relevantes:**

| Variable | Descripción |
|---|---|
| `PERITOLINE_AUTO_SYNC` | Activar/desactivar (default: `true`) |
| `PERITOLINE_AUTO_SYNC_COOLDOWN_MS` | Tiempo mínimo entre sincronizaciones del mismo nexp (default: `45000`) |
| `PERITOLINE_AUTO_SYNC_HEADLESS` | Playwright en modo headless (default: `true`) |
| `PERITOLINE_AUTO_SYNC_DRY_RUN` | Simular sin subir datos (default: `false`) |
| `UPLOAD_CONVERSATIONS_TO_PL` | Alias de control global (default: `true`) |

**Sincronización manual:**

```bash
npm run peritoline:sync -- --encargo 880337292
```

---

## Limpieza automática de datos

El scheduler ejecuta las tareas de limpieza en cada ciclo, sin restricción horaria:

| Tarea | Criterio | Variable |
|---|---|---|
| Eliminar filas del Excel | Filas con `Fecha Encargo` anterior a N días | `SINIESTRO_CLEANUP_DAYS` (7) |
| Eliminar PDFs | Archivos en `docs/conversations/` con más de N días | `PDF_CLEANUP_DAYS` (7) |

Las filas eliminadas del Excel se loguean con su nexp. Una vez eliminada una fila, ese número de expediente ya no será procesado por el bot.

---

## Estructura del proyecto

```
chatbot_ia/
├── src/
│   ├── channels/
│   │   └── whatsappAdapter.js       # Adaptador Meta Cloud API
│   ├── utils/
│   │   ├── logger.js                # Logging seguro sin PII
│   │   ├── atomicWrite.js           # Escritura atómica JSON + permisos
│   │   ├── excelManager.js          # I/O del Excel (negocio + estado técnico)
│   │   └── pdfGenerator.js          # Generación de PDFs de transcripción
│   ├── bot/
│   │   ├── index.js                 # Servidor Express + webhook handler
│   │   ├── messageHandler.js        # Pipeline de procesamiento de mensajes
│   │   ├── conversationManager.js   # CRUD de estado + migración de datos
│   │   ├── stateMachine.js          # Stages y transiciones válidas
│   │   ├── reminderScheduler.js     # Scheduler unificado (inactividad + recordatorios)
│   │   ├── peritolineAutoSync.js    # Disparador asíncrono de sincronización PeritoLine
│   │   ├── sendMessage.js           # Envío de mensajes WhatsApp (bajo nivel)
│   │   ├── templateSender.js        # Envío del template inicial
│   │   ├── dedup.js                 # Deduplicación por messageId
│   │   └── rateLimiter.js           # Rate limit por usuario y global
│   ├── ai/
│   │   └── aiModel.js               # Cliente Gemini con fallback de modelos
│   └── sendInitialMessage.js        # CLI de envío masivo desde Excel
├── data/
│   └── allianz_latest.xlsx          # Excel fuente (datos de negocio + estado técnico)
├── docs/
│   ├── pront/
│   │   └── Promp IA Whatsapp.docx   # System prompt (reglas 1-7 + variables del expediente)
│   └── conversations/
│       └── conversation_[nexp].pdf  # Transcripciones generadas automáticamente
├── scripts/
│   ├── peritoline_sync.js           # Script de sincronización con PeritoLine (Playwright)
│   └── ngrok_webhook.sh             # Helper para desarrollo con ngrok
├── logs/
│   └── bot.log                      # Log de aplicación (si SAVE_LOGS_TO_FILE=true)
└── package.json
```

---

## Seguridad implementada

### Logging sin PII (`src/utils/logger.js`)

```javascript
const log = require('./utils/logger');

log.info('Enviando a 346123456789');   // → "Enviando a 3461***89"
log.info({ telefono, nombre, text });  // campos enmascarados automáticamente
log.debug('payload completo:', body);  // solo visible con LOG_LEVEL=debug
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
- Permisos en Linux/WSL: directorios `data/` → `700`, ficheros → `600`

### Deduplicación (`src/bot/dedup.js`)

- Evita procesar dos veces el mismo mensaje si Meta reintenta el webhook
- Clave: `channel:userId:messageId` con TTL de 10 minutos

### Rate limiting (`src/bot/rateLimiter.js`)

- **Por usuario**: `RATE_USER_MAX` mensajes / `RATE_USER_WIN_MS` (default: 10/min)
- **Global**: `RATE_GLOBAL_MAX` mensajes / `RATE_GLOBAL_WIN_MS` (default: 60/min)
- Si se supera el límite: drop silencioso (no se responde para no crear bucles)

### Máquina de estados (`src/bot/stateMachine.js`)

- Bloquea la llamada a Gemini si el stage es `cerrado` o `escalated`
- Responde con mensajes predefinidos seguros en lugar de llamar a la IA
- `isValidTransition(from, to)` valida transiciones antes de persistirlas

### Fallback de modelos Gemini (`src/ai/aiModel.js`)

- Modelo primario: `gemini-2.5-flash`
- Fallbacks: `gemini-1.5-flash`, `gemini-1.5-flash-8b`
- Cambia automáticamente ante errores 429/RESOURCE_EXHAUSTED y vuelve al primario tras 5 min
- Si todos los modelos fallan, devuelve un mensaje seguro al usuario

---

## Endpoints HTTP

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Health check básico (`{ status: "ok" }`) |
| `GET` | `/health` | Estado detallado (modelo IA, tokens configurados) |
| `GET` | `/webhook` | Verificación del webhook de Meta (challenge) |
| `POST` | `/webhook` | Recibe mensajes entrantes de WhatsApp |
