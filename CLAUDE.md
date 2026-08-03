# CLAUDE.md

Guía para Claude Code en este repositorio.

## Qué es esto

API intermediaria que centraliza la comunicación por bots de Telegram (y en
el futuro WhatsApp) para las apps del ecosistema: GymTracker, Study Master y
las que vengan. Es un servicio de **transporte e identidad de canal**.

## Estado del proyecto

> **comm-tool está en el camino crítico de GymTracker desde el 2026-08-02.**
> El webhook del bot apunta acá y los entrantes se entregan a
> `/api/messaging/inbound` de GymTracker. Si comm-tool se cae, el bot de
> gimnasio deja de registrar series. Ver §El corte, más abajo, que incluye el
> rollback.

Fase 5 — Scheduler **completa** (2026-08-03, verificada contra producción).
`schedules` con único `(app_id, app_user_id, name)`, `POST /v1/schedules` y
`DELETE /v1/schedules/:name`, y el disparo de callbacks firmados desde el mismo
`/internal/tick` que ya movía los reintentos. El cálculo de la próxima
ejecución usa `croner`. 225 tests, migración `0004` aplicada.

**comm-tool no compone el mensaje del programado**: postea `{ scheduleId,
name, userId, firedAt }` al `schedule_callback_url` de la app y ella decide qué
decir. Hay un test que verifica que el cuerpo no contenga texto.

Dos detalles que se pagan caro si se invierten:

- **Al fallar un callback, `next_run_at` vuelve al horario original**, no se
  queda en el lease del claim. Si quedara en el lease, cada reintento
  recalcularía la ventana de gracia contra él y el programado se reintentaría
  para siempre. La ventana es de **una hora**: con el ticker cada 15 minutos da
  ~4 reintentos y después marca `missed`.
- **El `deliveryId` del callback es `<scheduleId>:<horarioAgendado>`.** Con un
  uuid nuevo por intento, un reintento mandaría el aviso dos veces.

El check-in nocturno de GymTracker se construyó **directo sobre el scheduler**,
sin pasar por Vercel Cron. Su spec preveía hacerlo ahí y migrarlo después,
aceptando un jitter de una hora; como comm-tool llegó primero, se saltó ese
paso y el aviso sale a las 22:00 exactas de Buenos Aires.

Fase 4 — Cliente y migración **completa** (2026-08-02, verificada contra
producción). Paquete cliente en `src/client/`, distribuido como dependencia git
anclada a `v0.1.0`; suite de conformidad que **las dos implementaciones pasan**
—la de Telegram directo de GymTracker y la de comm-tool—; y el corte del
webhook, hecho y verificado con un mensaje real.

El circuito completo anda: Telegram → webhook de comm-tool → entrega firmada →
GymTracker parsea la serie → responde por `POST /v1/messages` → Telegram. Se
verificó **antes** de mover el webhook, mandando un update sintético al
endpoint de comm-tool mientras Telegram todavía apuntaba a GymTracker: si algo
fallaba, no se perdía nada.

Fase 3 — Salientes **completa** (2026-08-02, verificada contra producción).
`POST /v1/messages` resuelve el contacto por `app_user_id`, saca el token del
bot de la app y manda por Telegram, síncrono. La fila de `outbound_messages` se
**reserva antes** del envío: por eso `status` tiene un tercer valor, `sending`,
que el spec no lista. Idempotencia por `(app_id, idempotency_key)`, opt-in: sin
clave no se deduplica nada. 181 tests, migración `0003` aplicada.

Verificado con envíos reales al chat de `@gymtrackerjaddbot`: un saliente
suelto, la misma `idempotencyKey` dos veces —respuestas idénticas, **una sola**
fila y **un solo** mensaje en el chat—, una respuesta citada, `404 not_linked`
y `400 invalid_request` con más de 4096 caracteres. Al terminar quedó todo en
`sent`, nada en `sending`, y el contacto de prueba desvinculado.

En su momento el contacto se creó con un `INSERT` a mano, porque el webhook
todavía lo tenía GymTracker. Desde la fase 4 `/vincular` funciona de verdad,
pero el `INSERT` sigue siendo útil: **el saliente solo necesita el token y un
contacto, no el webhook**, así que se puede probar aunque el registro esté en
otro lado.

El `replyToMessageId` viaja en ids **del proveedor**, en las dos direcciones,
porque el entrante de la fase 2 ya los expone así. La respuesta devuelve los
dos ids —`messageId` nuestro y `providerMessageId` de Telegram— para que la
fase 4 elija cuál expone la interfaz `Messaging` sin tocar nada de acá.

`409 window_closed` **no está implementado**: depende de la ventana de 24 horas
de WhatsApp, que es fase 7. En Telegram no podría dispararse nunca.

Fase 2 — Entrega **completa** (2026-07-30, verificada contra producción).
`inbound_messages` con dedupe por `(bot_id, provider_update_id)`, el webhook
persistiendo el crudo antes del ack, entrega firmada con HMAC al `delivery_url`
de la app, backoff de 5 intentos, `/internal/tick` y `/internal/replay/:id`
detrás de un Bearer propio. 149 tests.

El ticker externo corre en **cron-job.org cada 15 minutos** contra
`/internal/tick`. Sin él, los intentos 3 a 5 no se disparan: los dos primeros
ocurren dentro de la invocación del webhook, y en serverless no queda ningún
proceso vivo entre requests que despierte al resto.

Fase 1 — Identidad completa (2026-07-29, verificada end-to-end contra
producción). Esquema de identidad (`apps`, `bots`, `contacts`, `link_codes`),
emisión y canje de códigos, autenticación de apps por API key con rotación,
webhook de Telegram con verificación timing-safe del secreto, `/vincular` con
sus ramas de rechazo, y respuesta a chats no vinculados.

El bot `@gymtrackerjaddbot` (id `8867091101`) está dado de alta con slug `gym`.

Fase 0 — Scaffold completa: Hono sobre Bun, runner de migraciones, CI, `/health`.

**Próxima fase:** Fase 6 — Study Master (segundo bot, recordatorios de
entregas). Generar el plan con `superpowers:writing-plans` contra el spec.

## El corte, y cómo volver atrás

El webhook de `@gymtrackerjaddbot` apunta a comm-tool desde el 2026-08-02:
`https://communication-tool-beta.vercel.app/webhooks/telegram/gym`.

**Un bot de Telegram tiene un solo webhook y es exclusivo.** El último que
llama a `setWebhook` se queda con todos los updates; el anterior deja de
recibir **sin error ni aviso de ningún lado**. Ninguna suite puede detectarlo:
el registro vive en Telegram, no en el repo. Si un entrante "no llega" y el
servicio está sano, esto es lo primero que hay que mirar:

```bash
cd ~/Projects/gym-tracker && T="$(grep '^TELEGRAM_BOT_TOKEN=' .env.local | cut -d= -f2- | tr -d '"')" && curl -s "https://api.telegram.org/bot$T/getWebhookInfo" && unset T
```

### Rollback

`/api/telegram` de GymTracker **sigue existiendo y funcionando**: el corte fue
un cambio de registro, no una migración de código. Volver es una sola llamada,
sin deploy:

```bash
cd ~/Projects/gym-tracker && T="$(grep '^TELEGRAM_BOT_TOKEN=' .env.local | cut -d= -f2- | tr -d '"')" && S="$(grep '^TELEGRAM_WEBHOOK_SECRET=' .env.local | cut -d= -f2- | tr -d '"')" && curl -s -X POST "https://api.telegram.org/bot$T/setWebhook" -H 'Content-Type: application/json' -d "{\"url\":\"https://gym-tracker-brown-one.vercel.app/api/telegram\",\"secret_token\":\"$S\",\"allowed_updates\":[\"message\"]}" && unset T S
```

Que los dos caminos convivan es deliberado y conviene que siga así hasta que
comm-tool acumule historial en producción.

### Cómo probar el circuito sin depender de Telegram

Se le puede postear un update sintético al webhook de comm-tool con el
`secret_token` correcto. Recorre todo —dedupe, entrega firmada, dominio de
GymTracker, respuesta por `/v1/messages`— y termina con un mensaje real en el
chat. Es lo que se usó para verificar **antes** de mover el registro, y sirve
igual para diagnosticar después:

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/webhooks/telegram/gym \
  -H "X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET_GYM>" \
  -H 'Content-Type: application/json' \
  -d '{"update_id":999001,"message":{"message_id":1,"chat":{"id":<CHAT_ID>,"type":"private"},"date":1785400000,"text":"press banca 3x8 70"}}'
```

Ojo con el `update_id`: repetirlo no hace nada, porque el dedupe por
`(bot_id, provider_update_id)` lo descarta. Para una prueba nueva, número nuevo.

### Los secretos que tienen que coincidir

Ninguno se puede leer de Vercel —están marcados como sensibles—, así que
verificar que coinciden no es posible: si se sospecha de ellos, se rotan los
dos lados a la vez.

| Secreto | Tiene que coincidir con |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET_GYM` | El `secret_token` registrado en `setWebhook` |
| `DELIVERY_SECRET_GYM` | `COMM_TOOL_DELIVERY_SECRET` de gym-tracker |

## Setup en una máquina nueva

Todos los secretos viven en Vercel, así que el `.env` se baja, no se escribe a
mano:

```bash
bun install
bun --bun x vercel link --yes --project communication-tool
bun --bun x vercel env pull .env --environment=production --yes
```

**Eso trae UNA sola variable usable, no cinco.** Medido el 2026-08-02:
`DATABASE_URL` baja en claro, y `INTERNAL_SECRET`, `TELEGRAM_TOKEN_GYM`,
`TELEGRAM_WEBHOOK_SECRET_GYM` y `DELIVERY_SECRET_GYM` bajan como el literal
`[SENSITIVE]`. Están bien cargadas en Vercel; lo que pasa es que están
marcadas como *sensibles*, y eso significa que se escriben pero no se leen
nunca más — ni por CLI ni por dashboard. No hay forma de darlo vuelta.

Para verificar en qué estado quedó el `.env`:

```bash
grep -c '=\[SENSITIVE\]' .env
```

Cualquier resultado distinto de `0` quiere decir que esas variables no sirven.

**Falla de la peor manera posible.** `createSecretReader` solo tira error con
valor vacío o ausente, y `[SENSITIVE]` es una cadena no vacía: pasa de largo,
llega hasta Telegram, y Telegram rechaza. El síntoma es un **502 que parece
problema del proveedor** cuando en realidad es de configuración local.

Consecuencia práctica: **en local solo se pueden probar los endpoints que
tocan la base y nada más** (`/v1/link-codes`, `/v1/contacts`, `/health`).
Cualquier cosa que firme, verifique un secreto o hable con Telegram
—`/v1/messages`, el webhook, la entrega— hay que probarla contra producción, o
cargar los secretos a mano en el `.env` sacándolos de su fuente original
(BotFather para el token del bot; los demás, regenerándolos).

`vercel link` deja además un `.env.local` con un token OIDC que no se usa para
nada acá y se puede ignorar.

**La API key de una app tampoco está en el `.env`**, y eso es correcto: es
credencial de la app consumidora, y acá solo vive su hash en
`apps.api_key_hash`. Para probar los endpoints `/v1` a mano hay que generar una
y rotarla:

```bash
KEY="$(openssl rand -hex 24)" && echo "GYM_API_KEY=$KEY" >> .env && bun run scripts/registrar-app.ts "$KEY"
```

Hoy rotar es inofensivo porque ningún consumidor la usa. Después de la fase 4
deja de serlo. Ojo: `vercel env pull` pisa el `.env` entero y se lleva puesta
la línea, así que hay que rehacerla después de cada pull.

Para verificar que quedó: `bun run test` en verde y `bun run db:migrate`
diciendo `Sin migraciones pendientes (3 aplicadas).`

## Operación

- **Si un entrante "no llega", mirá el webhook antes que el código.** Es
  exclusivo por bot y se lo puede haber llevado otro servicio sin dejar rastro.
  Ver §El corte, y cómo volver atrás.
- **Las variables de entorno en Vercel solo aplican a deploys nuevos.** Cargar
  una y no redeployar deja el servicio con la vieja: el webhook devolvió 500
  hasta hacer `vercel redeploy`. Vale cada vez que se sume un bot.
- **No hay poll contra la base.** Neon se suspende a los 5 minutos de
  inactividad y cobra por hora de cómputo: consultar cada pocos segundos para
  esperar un evento la mantiene despierta y se come el presupuesto. Es la misma
  razón por la que el ticker corre cada 15 minutos y no cada 5.
- **El `app_user_id` de un contacto es el uuid real de `auth.users` de la app**,
  no una etiqueta cualquiera. `message_log.user_id` de GymTracker lo referencia
  por clave foránea: uno inventado hace fallar la entrega con un 500 que parece
  un problema de firma. Hoy el contacto vivo es
  `fe35defa-f188-4e2e-978e-36f5d748abbc`.
- **Para probar salientes sin pasar por `/vincular`** se inserta el contacto a
  mano en `contacts` (`app_id`, `channel='telegram'`, `external_id`=el chat id,
  `app_user_id`) y se borra con `DELETE /v1/contacts/:userId`. El chat id propio
  lo dice `@userinfobot` con un `/start`.
- **Un programado que no dispara**: lo primero es mirar si la app tiene
  `schedule_callback_url`. En `NULL` el disparo se marca `failed` sin postear
  nada, que es indistinguible de un callback caído si no se mira la columna.

  ```sql
  SELECT s.name, s.cron, s.timezone, s.next_run_at, s.last_status,
         a.schedule_callback_url
  FROM schedules s JOIN apps a ON a.id = s.app_id ORDER BY s.next_run_at;
  ```
- **Un saliente trabado en `sending`** es una invocación que murió entre la
  reserva y la marca. Un reintento con la misma clave devuelve `409
  in_progress` a propósito: no se puede saber si el mensaje salió.

  ```sql
  SELECT app_user_id, status, provider_message_id, idempotency_key, error
  FROM outbound_messages ORDER BY created_at DESC LIMIT 20;
  ```
- **Dar de alta una app y un bot**: `bun run scripts/registrar-app.ts <api-key>`
  y después registrar el webhook con `setWebhook`, pasando el `secret_token`
  idéntico al valor de la variable que referencia `bots.webhook_secret_env`.
  Si difieren en un carácter, Telegram postea y el servicio rechaza con 401
  sin ninguna pista de por qué.
- **`INTERNAL_SECRET` tiene que estar en Production *y* en Preview.** `parseEnv`
  la exige, y corre al importar el módulo: si falta en Preview, el build pasa
  igual y el deploy revienta con 500 en el primer request. Hoy las dos
  comparten valor.
- **El header del ticker es `Authorization: Bearer <secreto>`**, no un header
  llamado `Bearer`. Con el nombre mal el servicio no encuentra el header y
  devuelve 401 sin más pistas. En cron-job.org conviene usar *Import from
  cURL* en vez de cargar el header a mano.
- **Inspeccionar entregas** cuando algo no llega:

  ```sql
  SELECT provider_update_id, delivery_status, delivery_attempts,
         next_attempt_at, last_error
  FROM inbound_messages ORDER BY received_at DESC LIMIT 20;
  ```

  Un `pending` con `next_attempt_at` ya vencido y que no se mueve significa
  que el ticker no está corriendo. Un `failed` se reprocesa con
  `POST /internal/replay/:messageId`.

## Required reading

- **`docs/superpowers/specs/2026-07-28-communication-tool-design.md`** — spec
  vigente. Leer antes de cualquier decisión arquitectónica.

## Invariantes

- **communication-tool nunca llama a un LLM** y **nunca lee datos de dominio**
  de sus consumidores. El parseo es de cada app.
- **La app nunca ve un `chat_id`. comm-tool nunca interpreta un
  `app_user_id`.**
- **Los secretos viven en variables de entorno.** La base guarda configuración
  y el *nombre* de la variable, nunca su valor.
- **Un saliente se reserva antes de mandarse.** La fila de `outbound_messages`
  nace en `sending` y recién después se llama al proveedor. Invertir el orden
  haría que dos reintentos solapados manden dos mensajes.
- **Un bot por app y canal**, impuesto por `bots_app_channel_unico`. Sin ese
  índice, "el bot de esta app" depende del orden del `SELECT`.
- **`src/app.ts` no lee `process.env`.** Recibe sus dependencias inyectadas;
  `src/index.ts` es el único que las arma. Por eso todos los tests corren sin
  red y sin base.
- **Nadie importa `@neondatabase/serverless` fuera de `src/db/`.**
- **`/health` no toca la base salvo con `?deep=1`.** Neon se suspende a los 5
  minutos de inactividad y cobra por hora de cómputo. Hay un test que lo
  blinda (`expect(db.pings).toBe(0)`): si lo rompés, se rompe el test.
- **Sin RLS y sin Supabase**: no hay cliente browser.

## Gotchas del tooling

- **Los imports relativos llevan `.js`, siempre**: `import { x } from './foo.js'`
  aunque el archivo sea `foo.ts`. Bun y Vitest resuelven sin extensión, pero
  Vercel transpila a `.js` y los corre con el resolver ESM de Node, que la
  **exige**: sin ella el deploy tira `ERR_MODULE_NOT_FOUND` en runtime con
  todos los tests en verde. Por eso el tsconfig usa `"module": "nodenext"`, que
  convierte ese error de producción en un error de `bun run typecheck`. No
  cambiar a `bundler` ni a `Preserve`: la resolución laxa es justamente lo que
  esconde el bug.
- **El preset de Hono de Vercel elige el entrypoint por convención, y es
  frágil.** Dos reglas que hay que respetar o el deploy rompe en runtime
  mientras todo pasa localmente:
  1. **No puede existir `src/app.ts`.** El preset lo prefiere sobre
     `src/index.ts` y lo ejecuta como handler, aunque no tenga default export.
     Por eso la factory vive en `src/create-app.ts`.
  2. **`src/index.ts` tiene que importar `hono`.** El preset rechaza cualquier
     entrypoint que no lo haga (`No entrypoint found which imports hono`). De
     ahí el `import type { Hono }` y la anotación `const app: Hono`: no es
     decorativo, sin eso no buildea.

  Para verificarlo sin deployar: `bun --bun x vercel build --yes` y mirar que
  `.vercel/output/functions/index.func/.vc-config.json` diga
  `"handler": "src/index.js"`.
- **El CLI de Vercel necesita `bun --bun x vercel`**, no `vercel` a secas: el
  shebang del binario pide `node`, que no está instalado.
- **TypeScript fijado en `^6`.** `bun add -d typescript` trae la 7, que es el
  port nativo a Go, y `typescript-eslint` todavía no soporta su API: el lint
  falla entero. No subir a 7 hasta que typescript-eslint lo anuncie.
- **Zod 4 se importa como namespace**: `import * as z from 'zod'`. Con
  `import { z } from 'zod'`, `z` queda `undefined` bajo Vitest según qué entry
  point del paquete se resuelva.
- **ESLint 10 trae `preserve-caught-error`**: al re-lanzar dentro de un
  `catch`, hay que pasar `{ cause: error }`.
- **No usar `import.meta.dir`** en módulos que importen los tests: existe en
  Bun pero no cuando Vitest los carga. Usar
  `dirname(fileURLToPath(import.meta.url))`.
- **`bun run test` NO carga el `.env`, y por eso los tests de integración se
  saltean en silencio.** Bun inyecta el `.env` solo cuando el código lo ejecuta
  *su* runtime; vitest corre bajo node y no lo ve. Medido: `bun --bun x vitest`
  ve `DATABASE_URL`, `bun x vitest` no; `bun -e` y `bun run src/db/migrate.ts`
  sí, porque son bun. El síntoma es traicionero: con el `.env` completo la
  suite sale **verde igual**, salteando los archivos de integración sin decir
  nada. Para correrlos de verdad hay que pasar la variable explícita:

  ```bash
  DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" bun run test
  ```
- **No usar `Bun.sql` ni `bun test`**, aunque la plantilla de `bun init` los
  sugiera. `Bun.sql` es exclusivo de Bun y rompería el deploy en el runtime
  Node de Vercel; Vitest es lo que usa el resto del ecosistema.

## Dos drivers de Neon, a propósito

- `neon()` (HTTP) para el runtime: baja latencia, una query por request.
- `Client` (WebSocket) solo en `src/db/migrate.ts`: el HTTP no soporta SQL
  multi-statement ni transacciones reales.

## Build, test, run

```bash
bun run dev         # servidor local en :3000 (PORT lo cambia)
bun run test        # Vitest
bun run lint        # ESLint
bun run typecheck   # tsc --noEmit
bun run db:migrate  # aplica migraciones pendientes
```

CI corre lint + typecheck + test en cada PR y push a main. Los 3 archivos
`*.integration.test.ts` se saltean solos si no hay `DATABASE_URL` — y también
si la hay pero no se la pasa explícita, ver el gotcha del `.env`.

`db:migrate` valida su entorno con `parseDatabaseEnv`, que pide **solo**
`DATABASE_URL`. No usar `parseEnv` ahí: arrastra `INTERNAL_SECRET`, que no
tiene nada que ver con migrar, y rompe el runner en cualquier entorno que solo
tenga la cadena de conexión.

Al verificar a mano, **no encadenar con pipes**: `bun run lint | tail` devuelve
el exit code de `tail` y tapa el fallo. Usar `set -e` y comandos sueltos.

**Para simular CI (sin base), usar `DATABASE_URL='' bun run test`.** Tienen que
verse 3 archivos salteados. `env -u DATABASE_URL` hoy también funciona —medido—
pero la variable explícita vacía gana en cualquier caso y no depende de si bun
propaga el `.env` al proceso hijo, que es justo lo que cambia entre versiones.

**Los tests de integración construyen sus clientes dentro de `beforeAll`, no
en el scope del `describe`.** Vitest evalúa el cuerpo de un `describe.skip`
para recolectar los tests: un `createSql('')` en el scope explota en el import
y tumba CI antes de poder saltear nada.

## Migraciones

Archivos `migrations/NNNN_snake_case.sql`, aplicados en orden, cada uno en su
propia transacción y registrados en `schema_migrations`. El runner falla si la
base tiene migraciones que no están en disco, o si aparece una anterior a la
última aplicada — nunca las aplica fuera de orden.

## Convenciones de commit

- **NO agregar `Co-Authored-By: Claude`** ni líneas de autoría de IA.
- Prefijos convencionales (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
- Commits chicos y revisables.

## Ante la duda

El spec responde la mayoría de las preguntas. Si algo genuinamente no está,
preguntar al usuario — no inventar.
