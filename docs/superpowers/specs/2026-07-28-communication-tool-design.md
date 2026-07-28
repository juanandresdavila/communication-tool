# communication-tool — Diseño

Fecha: 2026-07-28
Estado: aprobado, pendiente de plan de implementación
Repo: `communication-tool`

## Problema

Cada app del ecosistema que quiera hablar por Telegram o WhatsApp tiene que
implementar lo mismo: registrar un webhook, verificar el secreto del
proveedor, deduplicar reintentos, resolver qué usuario escribió, mandar
salientes, y programar recordatorios. GymTracker lo está haciendo hoy. Study
Master lo tendría que hacer mañana. La tercera app, de nuevo.

Peor que la duplicación de código es la duplicación de **secretos**: cada app
termina con el token de un bot en sus variables de entorno, y cada una
inventa su propio esquema de vinculación entre un chat y un usuario.

communication-tool centraliza el transporte y la identidad de canal en un
solo servicio, para que una app nueva se enchufe con una API key y una URL.

## Decisiones cerradas

Cerradas durante el brainstorming. No reabrir sin motivo nuevo.

| Decisión | Elección |
|---|---|
| Consumidores | GymTracker, Study Master y apps futuras de stack desconocido |
| telegram-alarmer | Fuera de alcance. Otro dominio, otro lenguaje, ya funciona |
| Usuarios finales | Uno solo (vos). Multi-usuario por dentro, sin flujos de aprobación |
| Forma | Servicio desplegado aparte **más** un paquete cliente delgado |
| Topología de bots | **Un bot de Telegram por app** |
| Ruteo de entrantes | Por bot receptor. Es un hecho, no una inferencia |
| Parseo con LLM | De cada app. comm-tool **nunca** llama a un LLM |
| Estado conversacional | De cada app. comm-tool aporta solo la mecánica de correlación |
| Identidad | comm-tool conoce el `chat_id`; la app solo su `app_user_id` |
| Auth app → comm-tool | Bearer con API key, hash en base, dos claves para rotar |
| Auth comm-tool → app | HMAC-SHA256 con timestamp y ventana anti-replay |
| Programación | Scheduler propio en modo callback |
| Runtime | Hono sobre Bun |
| Persistencia | Neon (Postgres plano, sin RLS, sin Supabase) |
| WhatsApp | Fuera de v1. El contrato lo contempla desde el día uno |
| Infra | Free tier hoy; servidor propio después, sin reescribir nada |

## Alcance

### Qué es

Un servicio de **transporte e identidad de canal**.

- Recibe los webhooks de los proveedores y verifica sus secretos.
- Sabe qué bot pertenece a qué app.
- Resuelve quién escribió: chat de Telegram → usuario de la app.
- Entrega el entrante a la app dueña, con reintentos e idempotencia.
- Manda salientes y devuelve el id del mensaje.
- Programa avisos recurrentes despertando a la app.
- Lleva el log unificado de todo lo que entró y salió.
- Autentica a las apps y guarda su configuración.

### Qué no es

**No entiende lo que dice un mensaje.** No es un parser ni un motor de
diálogo, y no compone el texto de las respuestas.

La razón es más fuerte que "el dominio es de cada app": para interpretar
`banca 4x10 60` hace falta el catálogo de ejercicios del usuario, que vive en
la base de GymTracker detrás de RLS. Que comm-tool parseara obligaría a que
leyera datos de dominio de sus consumidores — la dependencia invertida, y un
servicio de transporte con acceso de lectura a todo el ecosistema.

**La única excepción es identidad, que sí es su dominio:** comm-tool
intercepta `/vincular <código>` y contesta a los chats no vinculados. Todo lo
demás pasa opaco hacia la app.

### Fuera de alcance en v1

Sin UI de administración: se inspecciona con SQL. Sin cola de salida. Sin
rate limiting ni anti-abuso, porque hay un solo usuario. Sin inbox unificado
entre apps. Sin media: un entrante que no sea texto se loguea y se entrega
con `text: ""` más el `raw` completo, y la app decide; los salientes son solo
texto.

## Arquitectura

```
Telegram ──webhook/telegram/:bot──►  communication-tool  ──HTTP + HMAC──►  GymTracker
                                       (Hono / Bun)                        Study Master
                                            │                                   │
                                            ▼                                   │
                                     Neon (Postgres)      ◄────── /v1/messages ──┘
                                            ▲
                     ticker externo ────────┘
                     (cada 15 min → /internal/tick)
```

### Invariantes

- **comm-tool nunca llama a un LLM** y **nunca lee datos de dominio** de sus
  consumidores.
- **La app nunca ve un `chat_id`. comm-tool nunca interpreta un
  `app_user_id`.** Este corte es el que mantiene simple todo lo demás.
- **Los secretos viven en variables de entorno.** La base guarda
  configuración y el *nombre* de la variable, nunca su valor. Así no hay que
  construir cifrado en reposo y mudarse a otro host es copiar un `.env`. Las
  API keys de las apps sí van a la base, hasheadas: un hash no es un secreto.
- **El ack al proveedor ocurre antes de cualquier trabajo pesado**, apenas se
  verifica el secreto y se persiste el crudo.
- **Sin RLS y sin Supabase**: no hay cliente browser. El único acceso a la
  base es del propio servicio.
- **Postgres plano y HTTP puro**: nada en el diseño impide mudar el servicio
  a un servidor propio.
- **La lógica vive en módulos TypeScript puros**, testeables con Vitest sin
  red, igual que en Study Master y GymTracker.

### Runtime

Hono sobre Bun. Es una API sin una sola pantalla: traer Next.js entero para
cero UI no se paga solo. Deploy en Vercel hoy con el adapter de Hono;
contenedor de pocos MB en el servidor propio después.

Se descartó Next.js con route handlers (consistente con el resto del
ecosistema, pero arrastra un framework de UI para nada y autohospedarlo pesa
más) y Fastify sobre Node (más boilerplate, peor alineado con bun).

## Identidad y vinculación

El flujo se escribe una vez y sirve para todas las apps:

1. La web de la app llama `POST /v1/link-codes` con su `app_user_id` y recibe
   un código corto con vencimiento.
2. El usuario le manda `/vincular ABC123` al bot de esa app.
3. comm-tool canjea el código, crea el `contact` y confirma por chat.

El código es de 6 caracteres sobre un alfabeto sin ambigüedades (sin `0`/`O`,
sin `1`/`I`/`L`), de un solo uso, con vencimiento por defecto de 15 minutos.
Se aceptan `/vincular` y `/link`.

Un mensaje que llega de un chat no vinculado recibe el texto de
`bots.unlinked_message` — configurado por bot, para que comm-tool no tenga
copy específico de ninguna app hardcodeado — y no se entrega a nadie. Queda
registrado en `inbound_messages` con estado `skipped`.

## El contrato

### La interfaz (paquete cliente)

Es la misma que ya vive en `src/lib/messaging/` de GymTracker, precisada:

```ts
export interface IncomingMessage {
  userId: string              // app_user_id YA RESUELTO — nunca un chat_id
  text: string
  channel: 'telegram' | 'whatsapp'
  messageId: string
  replyToMessageId?: string   // el usuario respondió a un mensaje del bot
  receivedAt: string
  raw: unknown
}

export interface OutgoingMessage {
  userId: string
  text: string
  kind: 'reply' | 'notification'
  replyToMessageId?: string
  template?: { name: string; vars: Record<string, string> }
}

export interface Messaging {
  sendMessage(msg: OutgoingMessage): Promise<{ messageId: string }>
  parseIncoming(req: Request): Promise<IncomingMessage | null>
}
```

Dos detalles cargan casi todo el peso del diseño:

**`parseIncoming` devuelve `userId`, no `chat_id`.** Esa sola decisión es la
que hace que migrar sea cambiar una variable de entorno. La resolución vía
`profiles.telegram_chat_id` ocurre *dentro* del adapter de Telegram directo;
con comm-tool ya viene resuelta. El dominio ve lo mismo en ambos casos. Si el
`chat_id` se filtrara al dominio, la migración dejaría de ser barata.

**`kind` es gratis hoy y caro de retrofitear.** En Telegram `reply` y
`notification` son idénticos. En WhatsApp, `reply` es texto libre dentro de la
ventana de 24 horas y `notification` es una plantilla aprobada por Meta. La
app no puede saber si la ventana está abierta; comm-tool sí, porque tiene el
último entrante.

**`sendMessage` devuelve el `messageId`**, y ese id *es* la mecánica de
correlación: la app guarda "pregunté las reps en el mensaje N" y después
matchea contra `replyToMessageId` del entrante siguiente.

`parseIncoming` devuelve `null` cuando el request no corresponde a un mensaje
procesable: firma inválida o entrega ya vista. Un entrante sin texto **no**
devuelve `null` — llega con `text: ""` y el `raw` completo, y decide la app.

En Telegram, `kind` y `template` no cambian nada: se manda `text` en los dos
casos. La distinción existe para que el día que haya WhatsApp el call site ya
esté declarando su intención.

### API HTTP

| Método | Ruta | Auth | Qué hace |
|---|---|---|---|
| `POST` | `/v1/messages` | Bearer | Manda un mensaje |
| `POST` | `/v1/link-codes` | Bearer | Emite un código de vinculación |
| `GET` | `/v1/contacts/:userId` | Bearer | Estado de vinculación |
| `DELETE` | `/v1/contacts/:userId` | Bearer | Desvincula |
| `POST` | `/v1/schedules` | Bearer | Registra o actualiza un programado |
| `DELETE` | `/v1/schedules/:name` | Bearer | Da de baja un programado |
| `POST` | `/webhooks/telegram/:botSlug` | Secret token | Entrada de Telegram |
| `POST` | `/internal/tick` | Bearer | Reintentos y programados vencidos |
| `POST` | `/internal/replay/:messageId` | Bearer | Reintenta una entrega fallida |
| `GET` | `/health` | — | Liveness |

`POST /v1/messages` acepta
`{ userId, text, kind, replyToMessageId?, template?, idempotencyKey? }` y
devuelve `{ messageId, providerMessageId, status }`.

Errores relevantes: `404 not_linked` si el `app_user_id` no tiene contacto, y
`409 window_closed` si el canal exige plantilla y no se mandó ninguna. Ambos
son explícitos a propósito: la app decide qué hacer, comm-tool no adivina.

### Webhook de entrega (comm-tool → app)

```
POST <apps.delivery_url>
X-Comm-Signature:   t=<unix>,v1=<hmac-sha256(t + "." + body)>
X-Comm-Delivery-Id: <uuid>

{ messageId, userId, channel, text, replyToMessageId?, receivedAt, raw }
```

La app responde 2xx para confirmar. Cualquier otra cosa, o un timeout, cuenta
como fallo y dispara el reintento.

## Autenticación

Tres direcciones, tres mecanismos, todos estándar. Nada de OAuth: para tres
apps propias es ceremonia sin beneficio.

| Dirección | Mecanismo |
|---|---|
| app → comm-tool | `Authorization: Bearer <api key>`. Hash SHA-256 en base. Dos claves activas para rotar sin downtime |
| comm-tool → app | HMAC-SHA256 sobre `timestamp.body`, ventana anti-replay de 5 minutos, más `X-Comm-Delivery-Id` para idempotencia |
| Telegram → comm-tool | `X-Telegram-Bot-Api-Secret-Token` por bot |
| ticker → comm-tool | Bearer con un secreto propio |

**El token del bot nunca sale de comm-tool.** Después de migrar, GymTracker
deja de tenerlo: un secreto menos en un repo más.

## Entrega, reintentos e idempotencia

El ack es lo primero: comm-tool responde 200 a Telegram apenas verifica el
secreto y persiste el mensaje crudo. Todo lo demás ocurre después.

**Tres capas de idempotencia, y las tres hacen falta**, porque cada una cubre
el reintento de un actor distinto:

1. `(bot_id, provider_update_id)` único — Telegram reintenta si tardás.
2. `X-Comm-Delivery-Id` — comm-tool reintenta si la app estaba fría. La app
   debe deduplicar por este id.
3. `(app_id, idempotency_key)` único en salientes — la app reintenta y no se
   manda dos veces.

**Backoff: 5 intentos.** El primero es inmediato y el segundo a los 10
segundos, ambos dentro de la misma invocación del webhook (después del 200 a
Telegram). Los tres siguientes son nominalmente a 1, 5 y 30 minutos, y los
maneja el ticker. Agotados los cinco, el mensaje queda `failed` con el crudo
guardado y se reprocesa con `/internal/replay/:messageId`.

El primer reintento es rápido a propósito: en Vercel free una app fría es el
caso **normal**, no una anomalía.

Nota honesta sobre los tiempos: con un ticker cada 15 minutos, los reintentos
3 a 5 caen en el tick siguiente, así que los retrasos efectivos son de ~15,
~30 y ~45 minutos, no 1/5/30. En un servidor propio con cron cada minuto se
cumplen los nominales. No hace falta cambiar código, solo la frecuencia del
ticker.

**Los salientes son síncronos en v1.** La app llama, comm-tool manda, y
devuelve el `providerMessageId`. Si el proveedor falla, 502 y decide la app.
Una cola de salida agregaría complejidad y rompería la correlación, que
necesita el id en el momento de la llamada.

## Programación

Las apps registran programados con expresión cron y zona horaria. Al vencer,
comm-tool **no compone el mensaje**: despierta a la app.

```
tick → ¿venció algún schedule? → POST <apps.schedule_callback_url>   (HMAC)
                                 { scheduleId, name, userId, firedAt }
                              → la app arma el mensaje y llama /v1/messages
```

El modo callback es el único que existe. Un modo `static` de texto fijo sería
YAGNI: prácticamente todo programado real necesita datos de dominio — el
check-in nocturno lista los suplementos activos, el recordatorio de entregas
necesita saber qué vence.

Lo que se compra no es "centralizar" sino **escaparle a los límites de Vercel
Hobby**: cron arbitrario en vez de uno por día, zona horaria por usuario en
vez de UTC, y hora exacta en vez de ±1 hora de jitter.

### El ticker

El ticker externo hace falta **igual, con o sin programados**, porque los
reintentos lentos necesitan que algo los despierte: en serverless no hay
proceso corriendo entre requests. Ese es el mismo problema que GymTracker
resuelve con cierre perezoso de sesión.

**Frecuencia: cada 15 minutos.** Es un número elegido por un choque de free
tiers: Neon se suspende a los 5 minutos de inactividad y da 100 horas de
cómputo al mes, así que un ticker cada 5 minutos no la dejaría dormir nunca y
se comería el presupuesto. Conviene medir el consumo real la primera semana y
ajustar, no clavarlo por fe.

El ticker puede ser cron-job.org o `pg_cron` + `pg_net` de un proyecto
Supabase existente. Es configuración, no código. En el servidor propio pasa a
ser un cron real cada minuto, sin medidor, y la granularidad mejora sola.

## Modelo de datos

Postgres en Neon. Sin RLS: no hay cliente browser, el único acceso es del
servicio.

### `apps`
`id`, `slug` único, `name`, `api_key_hash`, `api_key_hash_next` (rotación),
`delivery_url`, `schedule_callback_url` (nullable),
`delivery_secret_env` (nombre de la env var), `active`, `created_at`.

### `bots`
`id`, `app_id`, `channel`, `slug` único (va en la URL del webhook),
`username`, `token_env`, `webhook_secret_env`, `unlinked_message`, `active`.

### `contacts`
`id`, `app_id`, `channel`, `external_id` (el `chat_id`), `app_user_id`,
`linked_at`, `blocked`.
Únicos: `(app_id, channel, external_id)` y `(app_id, channel, app_user_id)`.

### `link_codes`
`code` (PK), `app_id`, `app_user_id`, `expires_at`, `used_at`, `created_at`.

### `inbound_messages`
`id`, `bot_id`, `channel`, `provider_update_id`, `external_id`, `contact_id`
(nullable), `text`, `raw` (jsonb), `received_at`, `delivery_status`
(`pending | delivered | failed | skipped`), `delivery_attempts`,
`next_attempt_at`, `delivered_at`, `last_error`.
Único: `(bot_id, provider_update_id)`.

### `outbound_messages`
`id`, `app_id`, `contact_id`, `kind`, `text`, `template` (jsonb, nullable),
`provider_message_id`, `status` (`sent | failed`), `error`,
`idempotency_key`, `created_at`.
Único: `(app_id, idempotency_key)`.

### `schedules`
`id`, `app_id`, `app_user_id`, `name`, `cron`, `timezone`, `active`,
`next_run_at`, `last_run_at`, `last_status`.
Único: `(app_id, app_user_id, name)`.

## WhatsApp

Fuera de v1. Lo que queda preparado es lo caro de agregar después: el campo
`channel` en el contrato y en las tablas, la distinción `reply` vs
`notification`, el hueco de `template`, y el error `409 window_closed`.

Lo que **no** está construido: el cliente de la Cloud API, el registro de
plantillas, y el cálculo de la ventana de 24 horas.

Los datos verificados el 2026-07-28, para cuando llegue el momento:

- **Alta.** Hace falta un Meta Business Portfolio, una WhatsApp Business
  Account y un número de teléfono **que no esté ya en WhatsApp**. Verificación
  por OTP y método de pago cargado antes de poder mandar o recibir. La
  verificación de negocio con documentos es un paso aparte que para un solo
  usuario probablemente no haga falta: sin ella hay límites del orden de 250
  destinatarios únicos por 24 horas.
- **Costos.** Desde el 1/7/2025 se cobra por mensaje, no por conversación. Lo
  que se manda **dentro de la ventana de 24 horas desde el último mensaje del
  usuario es gratis**, incluidas las plantillas de utilidad. Fuera de la
  ventana se paga por plantilla aprobada; las de utilidad cuestan del orden de
  80-90% menos que las de marketing. Para un usuario, centavos por mes.
- **La consecuencia arquitectónica** es la que ya está absorbida en el
  contrato: en Telegram se puede mandar cualquier cosa en cualquier momento,
  gratis; en WhatsApp no. El check-in de las 22:00 cae fuera de la ventana
  cualquier día que no le hayas escrito al bot, y entonces no es texto libre
  sino una plantilla aprobada con slots de variables.

## Testing

comm-tool tiene poca lógica, pero la que tiene es del tipo que falla en
silencio. Va con TDD y Vitest, sobre TypeScript puro y sin red:

- Firma y verificación HMAC, incluida la ventana anti-replay.
- Deduplicación por las tres capas de idempotencia.
- Cálculo del backoff y de `next_attempt_at`.
- Próxima ejecución de un cron con zona horaria.
- Emisión, canje, vencimiento y reuso de códigos de vinculación.
- Cálculo de la ventana de 24 horas de WhatsApp.

Los clientes de proveedor se prueban contra payloads reales grabados como
fixtures: CI nunca llama a Telegram. Se incluye un caso de `update_id`
repetido y uno de entrante sin texto.

### Suite de conformidad

El paquete cliente incluye una **suite de conformidad de la interfaz
`Messaging`** que corren las dos implementaciones: la de Telegram directo de
GymTracker y la de comm-tool. Si las dos pasan la misma suite en CI,
"cambiar una variable de entorno" deja de ser una promesa y pasa a estar
verificado. Sin esto, la migración se descubre rota en producción.

CI en GitHub Actions: lint, typecheck, test y build en cada PR y push a main.

## Fases

| | Fase | Entregable |
|---|---|---|
| 0 | Scaffold | Hono + Bun, Neon, migraciones, CI, deploy, `/health` |
| 1 | Identidad | `apps`, `bots`, `contacts`, `link_codes`, webhook de Telegram, `/vincular`, respuesta a no vinculados |
| 2 | Entrega | `inbound_messages`, delivery con HMAC, reintentos, `/internal/tick`, replay manual |
| 3 | Salientes | `POST /v1/messages`, `outbound_messages`, idempotencia |
| 4 | Cliente | Paquete npm, suite de conformidad, **migración de GymTracker** |
| 5 | Scheduler | `schedules`, callbacks, migración del check-in nocturno |
| 6 | Study Master | Segundo bot, recordatorios de entregas |
| 7 | WhatsApp | Solo si aparece una necesidad real |

No saltear fases. Cada fase genera su plan con `superpowers:writing-plans`
contra este spec.

**comm-tool no bloquea a GymTracker.** GymTracker sigue con Telegram directo
hasta su propia fase 3 y se migra recién en la fase 4 de acá. Si comm-tool
nunca se terminara, GymTracker funciona igual.

## Cambios requeridos en las apps consumidoras

Estos cambios conviene hacerlos **antes** de escribir el código de GymTracker,
no después.

### GymTracker

1. **`parseIncoming` debe devolver `userId`, no `chat_id`.** La resolución vía
   `profiles.telegram_chat_id` va *adentro* del adapter de Telegram directo.
   Es el cambio más importante de la lista: si el `chat_id` se filtra al
   dominio, la migración deja de ser una variable de entorno.
2. **`sendMessage` suma `kind` y devuelve `{ messageId }`.** El id es lo que
   habilita correlacionar respuestas.
3. **La clave única de `message_log` no puede ser `telegram_update_id`.** Debe
   ser un `external_message_id` genérico que el adapter de comm-tool también
   pueda llenar.
4. **El cron de las 22:00 en Vercel Hobby se dispara entre las 22:00 y las
   22:59.** Hobby limita a una ejecución por día, solo en UTC, y reparte la
   carga dentro de la hora indicada. O se acepta el jitter, o se espera la
   fase 5 de acá. Hoy el spec de GymTracker dice 22:00 y eso no se va a
   cumplir.
5. Tras migrar, `telegram_link_codes` y `profiles.telegram_chat_id` quedan
   vestigiales, y el token del bot desaparece de las variables de entorno de
   GymTracker.

### Study Master

No tiene mensajería todavía, así que se ahorra la migración: adopta la misma
interfaz `src/lib/messaging/` desde el día uno y va directo al adapter de
comm-tool.

## Dependencias externas

Las resuelve el usuario, no el código.

- Cuenta de Neon con base creada — fase 0.
- Target de deploy (Vercel) conectado al repo — fase 0.
- Un bot de Telegram por app, creado con @BotFather; tokens y secretos de
  webhook como variables de entorno — fase 1.
- Ticker externo apuntando a `/internal/tick` cada 15 minutos: cron-job.org o
  `pg_cron` + `pg_net` de un proyecto Supabase existente — fase 2.
