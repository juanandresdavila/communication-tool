# communication-tool — Fase 3: Salientes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una app pueda mandarle un mensaje a uno de sus usuarios con una sola llamada HTTP, sin conocer el `chat_id` ni el token del bot, y que reintentar esa llamada nunca produzca dos mensajes en el chat.

**Architecture:** `POST /v1/messages` resuelve el contacto por `app_user_id`, resuelve el bot de la app, **reserva la fila en `outbound_messages` antes de mandar**, llama a Telegram y marca el resultado. La reserva previa es lo que hace que la clave de idempotencia sirva: si insertáramos después del envío, dos reintentos solapados mandarían dos mensajes y recién ahí chocarían. Los salientes son síncronos: la app llama, comm-tool manda, y devuelve el `providerMessageId` en la misma respuesta.

**Tech Stack:** Hono, Bun, TypeScript, Zod, `@neondatabase/serverless`, Vitest, Neon.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## Alcance de esta fase

Del spec, §Fases: «Salientes — `POST /v1/messages`, `outbound_messages`, idempotencia».

**Entra:** la tabla `outbound_messages`, el endpoint `POST /v1/messages` autenticado por API key, la resolución `app_user_id → contacto → chat_id` (que la app nunca ve), la resolución del bot de la app para sacar el token, la idempotencia por `(app_id, idempotency_key)`, el error `404 not_linked`, el `502` cuando el proveedor rechaza, y el soporte de `replyToMessageId` en el cliente de Telegram.

**No entra, y es deliberado:**

- **`409 window_closed`.** Está en el contrato del spec (§API HTTP) pero **no se puede implementar todavía**: depende del cálculo de la ventana de 24 horas de WhatsApp, que el propio spec pone fuera de v1 (§WhatsApp: «Lo que **no** está construido: … el cálculo de la ventana de 24 horas»). En Telegram la ventana no existe y el error nunca podría dispararse. Se acepta y se guarda `template`, para que el día que haya WhatsApp el dato esté; el error llega con el canal.
- **Cola de salida.** El spec la descarta explícitamente (§Entrega): rompería la correlación, que necesita el id en el momento de la llamada. Un fallo del proveedor devuelve 502 y decide la app.
- **`contacts.blocked`.** La columna existe desde la fase 1 y **nadie la escribe todavía**. Leerla acá sería código muerto. Cuando algo la escriba —el candidato natural es un 403 de Telegram, "bot was blocked by the user"— el chequeo entra con quien la escriba.
- **El paquete cliente.** Fase 4. Esta fase entrega la API HTTP; el mapeo a la interfaz `Messaging` viene después.
- **`schedules`.** Fase 5, que va a *consumir* este endpoint.

### Tres decisiones que el spec no cierra, y por qué se resuelven así

**1. `replyToMessageId` viaja en el espacio de ids del proveedor.** El spec no dice de qué espacio es. La respuesta sale de lo que ya está en producción: el entrante que la fase 2 le entrega a la app trae `replyToMessageId` sacado de `reply_to_message.message_id` de Telegram — o sea, ya es un id del proveedor. Si el saliente usara ids de comm-tool, el mismo campo significaría dos cosas distintas según la dirección. Además `inbound_messages` guarda `provider_update_id`, que **no** es un message id, así que traducir un id nuestro a uno de Telegram ni siquiera sería posible hoy sin cambiar el esquema.

No rompe ninguna invariante: un message id no es un `chat_id`. Y no cierra ninguna puerta: la respuesta devuelve **los dos** ids (`messageId` nuestro, `providerMessageId` de Telegram), así que la fase 4 puede elegir cuál expone la interfaz `Messaging` sin tocar nada de acá.

**2. `outbound_messages.status` tiene tres valores, no dos.** El spec lista `sent | failed`. Reservar antes de mandar obliga a un tercero, `sending`, para la ventana entre la reserva y el resultado. No es una decisión de diseño distinta: es la consecuencia física de la que sí tomó el spec («la app reintenta y no se manda dos veces»). Con solo dos estados habría que insertar después del envío, y entonces dos reintentos solapados mandarían dos mensajes.

**3. Un bot por app y canal pasa a ser un único de base.** El spec lo decide en §Decisiones cerradas («Topología de bots: **Un bot de Telegram por app**») pero la tabla `bots` de la fase 1 no lo impone. El saliente necesita responder *"¿cuál es el bot de esta app?"* con una sola fila; sin el único, la respuesta depende del orden del `SELECT` y un mensaje podría salir por un bot distinto en cada request. La migración lo agrega como índice único parcial sobre `active`, para poder desactivar un bot y dar de alta su reemplazo sin chocar.

### La dependencia que sigue abierta

Igual que en la fase 2: GymTracker todavía no consume nada de esto. La verificación de punta a punta se hace con `curl` contra el bot real, y el mensaje llega a un Telegram de verdad — eso alcanza, y no depende de que GymTracker exista.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/0003_outbound_messages.sql` | La tabla, su único de idempotencia, y el único de bot por app/canal |
| `src/db/repositories/outbound-messages.ts` | `OutboundMessagesRepo` sobre Neon. La reserva atómica vive acá |
| `src/outbound/send.ts` | El caso de uso: resolver, reservar, mandar, marcar |
| `src/routes/messages.ts` | `POST /v1/messages`. Solo traduce HTTP ↔ caso de uso |
| `src/db/ports.ts` | **Modificar**: `OutboundMessage`, `OutboundMessagesRepo`, `BotsRepo.findByAppAndChannel` |
| `src/db/repositories/bots.ts` | **Modificar**: `findByAppAndChannel` |
| `src/channels/telegram/client.ts` | **Modificar**: `reply_parameters` |
| `src/test-support/fake-repos.ts` | **Modificar**: dobles de los dos repositorios |
| `src/test-support/fake-deps.ts` | **Modificar**: `outbound` |
| `src/create-app.ts` | **Modificar**: `Deps.outbound` y montaje de la ruta |
| `src/index.ts` | **Modificar**: construir el repositorio real |

**El corte que sostiene la fase:** `enviarSaliente` decide *qué pasó* con vocabulario propio (`sent`, `duplicate`, `not_linked`, `in_progress`, `no_bot`, `send_failed`) y la ruta se limita a traducir eso a códigos HTTP. Toda la lógica frágil —el orden resolver/reservar/mandar/marcar— se prueba sin levantar un servidor.

**Esta fase no agrega ninguna variable de entorno.** No hay que cargar nada en Vercel ni redeployar por configuración, así que el gotcha de CLAUDE.md sobre las variables no aplica.

---

## Task 1: Migración de `outbound_messages`

**Files:**
- Create: `migrations/0003_outbound_messages.sql`

- [ ] **Step 1: Escribir la migración**

`migrations/0003_outbound_messages.sql`:

```sql
CREATE TABLE outbound_messages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  contact_id          uuid        REFERENCES contacts (id) ON DELETE SET NULL,
  app_user_id         text        NOT NULL,
  channel             text        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  kind                text        NOT NULL CHECK (kind IN ('reply', 'notification')),
  text                text        NOT NULL,
  template            jsonb,
  reply_to_message_id text,
  provider_message_id text,
  status              text        NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'failed')),
  error               text,
  idempotency_key     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, idempotency_key)
);

-- Para inspeccionar el log de una app por SQL, que es la única UI que hay.
CREATE INDEX outbound_messages_app_created_idx
  ON outbound_messages (app_id, created_at DESC);

-- Un bot por app y canal (spec, §Decisiones cerradas). Sin esto "el bot de
-- esta app" es ambiguo y un saliente podría salir por un bot distinto en cada
-- request. Parcial sobre `active` para poder desactivar un bot y dar de alta
-- su reemplazo sin que choquen.
CREATE UNIQUE INDEX bots_app_channel_unico
  ON bots (app_id, channel)
  WHERE active;
```

Tres cosas que no son obvias:

**`idempotency_key` es nullable y el único igual funciona.** Postgres trata los `NULL` como distintos entre sí, así que las llamadas sin clave nunca chocan y no hace falta un índice parcial ni un valor centinela.

**`contact_id` es nullable con `ON DELETE SET NULL`, y además está `app_user_id`.** Es el mismo razonamiento que llevó a desnormalizar en `inbound_messages`: desvincular un contacto no puede borrar ni mutilar el historial de lo que se le mandó. El `contact_id` es el puntero preciso mientras el vínculo existe; el `app_user_id` es lo que sobrevive.

**`status` arranca en `sending`.** Ver §Tres decisiones, punto 2.

- [ ] **Step 2: Aplicarla y verificar idempotencia**

```bash
bun run db:migrate
```

Esperado: `Aplicando 0003_outbound_messages.sql...` y `Listo. 1 migración(es) aplicada(s).`

```bash
bun run db:migrate
```

Esperado: `Sin migraciones pendientes (3 aplicadas).`

- [ ] **Step 3: Verificar los dos únicos contra la base**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); const u=await c.query(\"SELECT conname FROM pg_constraint WHERE conrelid='outbound_messages'::regclass AND contype='u'\"); console.log('unicos de outbound:', u.rows.length); const b=await c.query(\"SELECT indexname FROM pg_indexes WHERE tablename='bots' AND indexname='bots_app_channel_unico'\"); console.log('unico de bots:', b.rows.length); await c.end()"
```

Esperado: `unicos de outbound: 1` y `unico de bots: 1`.

- [ ] **Step 4: Verificar que dos claves nulas conviven y dos iguales no**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); await c.query(\"INSERT INTO apps (slug,name,api_key_hash,delivery_url,delivery_secret_env) VALUES ('_probe','P','h','https://x.test','S')\"); const {rows}=await c.query(\"SELECT id FROM apps WHERE slug='_probe'\"); const id=rows[0].id; const ins=(k)=>c.query('INSERT INTO outbound_messages (app_id,app_user_id,channel,kind,text,idempotency_key) VALUES (\$1,\$2,\$3,\$4,\$5,\$6)',[id,'u','telegram','reply','t',k]); await ins(null); await ins(null); console.log('dos nulas: ok'); await ins('k'); try { await ins('k'); console.log('PROBLEMA: la clave repetida entro'); } catch { console.log('clave repetida: rechazada, ok'); } await c.query(\"DELETE FROM apps WHERE slug='_probe'\"); await c.end()"
```

Esperado: `dos nulas: ok` y `clave repetida: rechazada, ok`.

- [ ] **Step 5: Commit**

```bash
git add migrations/
git commit -m "feat: tabla outbound_messages e idempotencia por clave de la app"
```

---

## Task 2: El bot de una app

`BotsRepo` hoy solo sabe buscar por slug, que es lo que necesita el webhook. El saliente pregunta al revés.

**Files:**
- Modify: `src/db/ports.ts`, `src/db/repositories/bots.ts`, `src/test-support/fake-repos.ts`
- Test: `src/db/repositories/repositories.integration.test.ts`

- [ ] **Step 1: Sumar el método al puerto**

En `src/db/ports.ts`, reemplazá la interfaz `BotsRepo` entera por:

```ts
export interface BotsRepo {
  findBySlug(slug: string): Promise<Bot | null>
  /**
   * El bot activo de una app en un canal. Devuelve como mucho uno: el índice
   * único `bots_app_channel_unico` lo garantiza en la base, no acá.
   */
  findByAppAndChannel(appId: string, channel: Channel): Promise<Bot | null>
}
```

- [ ] **Step 2: Escribir el test de integración que falla**

En `src/db/repositories/repositories.integration.test.ts`, agregá este test justo después del que dice `'encuentra el bot por slug y mapea los nombres de las env vars'`:

```ts
  it('encuentra el bot activo de una app por canal', async () => {
    const bot = await bots.findByAppAndChannel(appId, 'telegram')
    expect(bot?.slug).toBe(SLUG_BOT)

    expect(await bots.findByAppAndChannel(appId, 'whatsapp')).toBeNull()
    expect(
      await bots.findByAppAndChannel(
        '00000000-0000-0000-0000-000000000000',
        'telegram',
      ),
    ).toBeNull()
  }, 30_000)
```

- [ ] **Step 3: Correr el test para verificar que falla**

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" bun run test src/db/repositories/repositories.integration.test.ts
```

Esperado: FAIL — `bots.findByAppAndChannel is not a function`.

Si en vez de fallar dice `skipped`, la variable no llegó: revisá el gotcha del `.env` en CLAUDE.md.

- [ ] **Step 4: Implementar en el repositorio real**

En `src/db/repositories/bots.ts`, sumá al objeto que devuelve `createBotsRepo`, después de `findBySlug`:

```ts
    async findByAppAndChannel(appId, channel) {
      const filas = (await sql`
        SELECT id, app_id, channel, slug, username, token_env,
               webhook_secret_env, unlinked_message, active
        FROM bots
        WHERE app_id = ${appId} AND channel = ${channel} AND active = true
        LIMIT 1
      `) as FilaBot[]
      const fila = filas[0]
      return fila ? aBot(fila) : null
    },
```

- [ ] **Step 5: Implementar en el doble**

En `src/test-support/fake-repos.ts`, reemplazá `createFakeBotsRepo` entera:

```ts
export function createFakeBotsRepo(bots: Bot[]): BotsRepo {
  return {
    async findBySlug(slug) {
      return bots.find((b) => b.slug === slug) ?? null
    },
    async findByAppAndChannel(appId, channel) {
      return (
        bots.find(
          (b) => b.appId === appId && b.channel === channel && b.active,
        ) ?? null
      )
    },
  }
}
```

- [ ] **Step 6: Correr los tests para verificar que pasan**

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" bun run test src/db/repositories/repositories.integration.test.ts
```

Esperado: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/db/ports.ts src/db/repositories/bots.ts src/test-support/fake-repos.ts src/db/repositories/repositories.integration.test.ts
git commit -m "feat: buscar el bot de una app por canal"
```

---

## Task 3: Puerto y repositorio de `outbound_messages`

La reserva atómica es el corazón de la idempotencia y vive en un solo statement.

**Files:**
- Modify: `src/db/ports.ts`, `src/test-support/fake-repos.ts`
- Create: `src/db/repositories/outbound-messages.ts`
- Test: `src/db/repositories/outbound-messages.integration.test.ts`

- [ ] **Step 1: Sumar los tipos y el puerto**

Agregá al final de `src/db/ports.ts`:

```ts
export type OutboundKind = 'reply' | 'notification'
export type OutboundStatus = 'sending' | 'sent' | 'failed'

export interface OutboundTemplate {
  name: string
  vars: Record<string, string>
}

export interface OutboundMessage {
  id: string
  appId: string
  contactId: string | null
  appUserId: string
  channel: Channel
  kind: OutboundKind
  text: string
  template: OutboundTemplate | null
  replyToMessageId: string | null
  providerMessageId: string | null
  status: OutboundStatus
  error: string | null
  idempotencyKey: string | null
  createdAt: string
}

export interface OutboundMessagesRepo {
  /**
   * Reserva el envío y devuelve la fila reservada, o `null` si la clave de
   * idempotencia ya está tomada por un envío en vuelo o ya concluido.
   *
   * Reservar ANTES de mandar es lo que hace que la clave sirva: si la fila se
   * insertara después del envío, dos reintentos solapados mandarían dos
   * mensajes y recién ahí chocarían.
   *
   * Una fila `failed` sí se puede volver a reservar —el mensaje anterior nunca
   * salió— y en ese caso **se devuelve con su contenido original**, no con el
   * del pedido nuevo: la clave identifica al mensaje, así que un reintento
   * reenvía lo mismo aunque el cuerpo del request haya cambiado.
   *
   * Con `idempotencyKey: null` nunca hay conflicto y siempre devuelve fila.
   */
  claim(input: {
    appId: string
    contactId: string
    appUserId: string
    channel: Channel
    kind: OutboundKind
    text: string
    template: OutboundTemplate | null
    replyToMessageId: string | null
    idempotencyKey: string | null
  }): Promise<OutboundMessage | null>

  /** Para contestar el replay con el resultado que ya se había guardado. */
  findByIdempotencyKey(
    appId: string,
    idempotencyKey: string,
  ): Promise<OutboundMessage | null>

  marcarEnviado(id: string, providerMessageId: string): Promise<void>
  marcarFallido(id: string, error: string): Promise<void>
}
```

- [ ] **Step 2: Escribir el test de integración que falla**

`src/db/repositories/outbound-messages.integration.test.ts`:

```ts
import { Client } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import type { OutboundMessagesRepo } from '../ports.js'
import { createOutboundMessagesRepo } from './outbound-messages.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_outbound_app'

correr('outbound_messages contra una base real', () => {
  // Se construye en beforeAll: Vitest evalúa el cuerpo de un describe.skip.
  let repo: OutboundMessagesRepo
  let appId = ''
  let contactId = ''

  async function limpiar() {
    const c = new Client(DATABASE_URL)
    await c.connect()
    await c.query('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    repo = createOutboundMessagesRepo(createSql(DATABASE_URL))
    await limpiar()

    const c = new Client(DATABASE_URL)
    await c.connect()
    const app = await c.query<{ id: string }>(
      `INSERT INTO apps (slug, name, api_key_hash, delivery_url, delivery_secret_env)
       VALUES ($1, 'Test', 'h', 'https://ejemplo.test/inbound', 'S') RETURNING id`,
      [SLUG_APP],
    )
    const filaApp = app.rows[0]
    if (!filaApp) throw new Error('no se creó la app de prueba')
    appId = filaApp.id

    const contacto = await c.query<{ id: string }>(
      `INSERT INTO contacts (app_id, channel, external_id, app_user_id)
       VALUES ($1, 'telegram', '12345', 'u-1') RETURNING id`,
      [appId],
    )
    const filaContacto = contacto.rows[0]
    if (!filaContacto) throw new Error('no se creó el contacto de prueba')
    contactId = filaContacto.id
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  function base(idempotencyKey: string | null) {
    return {
      appId,
      contactId,
      appUserId: 'u-1',
      channel: 'telegram' as const,
      kind: 'reply' as const,
      text: 'hola',
      template: null,
      replyToMessageId: null,
      idempotencyKey,
    }
  }

  it('sin clave cada llamada reserva una fila nueva', async () => {
    const a = await repo.claim(base(null))
    const b = await repo.claim(base(null))
    expect(a?.status).toBe('sending')
    expect(b?.status).toBe('sending')
    expect(a?.id).not.toBe(b?.id)
  }, 30_000)

  it('con la misma clave la segunda reserva no devuelve nada', async () => {
    expect((await repo.claim(base('k-1')))?.status).toBe('sending')
    expect(await repo.claim(base('k-1'))).toBeNull()
  }, 30_000)

  it('dos reservas simultáneas con la misma clave: solo una gana', async () => {
    // Es el caso que la idempotencia existe para cubrir. Sin el único y el
    // ON CONFLICT, las dos entrarían y saldrían dos mensajes.
    const [a, b] = await Promise.all([
      repo.claim(base('k-2')),
      repo.claim(base('k-2')),
    ])
    expect([a, b].filter((r) => r !== null)).toHaveLength(1)
  }, 30_000)

  it('deja leer la fila ya enviada para contestar el replay', async () => {
    const creado = await repo.claim(base('k-3'))
    if (!creado) throw new Error('no se reservó')
    await repo.marcarEnviado(creado.id, 'tg-42')

    const leido = await repo.findByIdempotencyKey(appId, 'k-3')
    expect(leido?.status).toBe('sent')
    expect(leido?.providerMessageId).toBe('tg-42')
  }, 30_000)

  it('una fila fallida se vuelve a reservar; una enviada no', async () => {
    const creado = await repo.claim(base('k-4'))
    if (!creado) throw new Error('no se reservó')

    await repo.marcarFallido(creado.id, 'Telegram dijo que no')
    const reclamado = await repo.claim(base('k-4'))
    expect(reclamado?.id).toBe(creado.id)
    expect(reclamado?.status).toBe('sending')
    expect(reclamado?.error).toBeNull()

    await repo.marcarEnviado(creado.id, 'tg-7')
    expect(await repo.claim(base('k-4'))).toBeNull()
  }, 30_000)

  it('al re-reservar conserva el texto original, no el del pedido nuevo', async () => {
    // La clave identifica al mensaje. Si el reintento pudiera cambiarle el
    // texto, "idempotente" dejaría de querer decir nada.
    const creado = await repo.claim({ ...base('k-5'), text: 'el original' })
    if (!creado) throw new Error('no se reservó')
    await repo.marcarFallido(creado.id, 'x')

    const reclamado = await repo.claim({ ...base('k-5'), text: 'otro texto' })
    expect(reclamado?.text).toBe('el original')
  }, 30_000)

  it('guarda el template como objeto, no como string', async () => {
    const creado = await repo.claim({
      ...base('k-6'),
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })
    expect(creado?.template).toEqual({
      name: 'checkin',
      vars: { hora: '22:00' },
    })
  }, 30_000)
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" bun run test src/db/repositories/outbound-messages.integration.test.ts
```

Esperado: FAIL — `Cannot find module './outbound-messages.js'`.

- [ ] **Step 4: Escribir el repositorio**

`src/db/repositories/outbound-messages.ts`:

```ts
import type { Sql } from '../client.js'
import type {
  Channel,
  OutboundKind,
  OutboundMessage,
  OutboundMessagesRepo,
  OutboundStatus,
  OutboundTemplate,
} from '../ports.js'

interface Fila {
  id: string
  app_id: string
  contact_id: string | null
  app_user_id: string
  channel: string
  kind: string
  text: string
  template: unknown
  reply_to_message_id: string | null
  provider_message_id: string | null
  status: string
  error: string | null
  idempotency_key: string | null
  created_at: string
}

function aSaliente(f: Fila): OutboundMessage {
  return {
    id: f.id,
    appId: f.app_id,
    contactId: f.contact_id,
    appUserId: f.app_user_id,
    channel: f.channel as Channel,
    kind: f.kind as OutboundKind,
    text: f.text,
    template: (f.template ?? null) as OutboundTemplate | null,
    replyToMessageId: f.reply_to_message_id,
    providerMessageId: f.provider_message_id,
    status: f.status as OutboundStatus,
    error: f.error,
    idempotencyKey: f.idempotency_key,
    createdAt: new Date(f.created_at).toISOString(),
  }
}

export function createOutboundMessagesRepo(sql: Sql): OutboundMessagesRepo {
  return {
    async claim(input) {
      // Todo en UN statement: con el driver HTTP no hay transacciones, así que
      // la atomicidad tiene que estar en el SQL.
      //
      // El WHERE del DO UPDATE es el que decide. Solo se vuelve a tomar una
      // fila `failed`; si está `sending` o `sent` el UPDATE no afecta ninguna
      // fila, el RETURNING viene vacío, y quien llama se entera de que el
      // envío no es suyo. Y como el DO UPDATE no toca `text` ni `kind`, un
      // reintento reenvía el mensaje original aunque el cuerpo haya cambiado.
      const filas = (await sql`
        INSERT INTO outbound_messages (
          app_id, contact_id, app_user_id, channel, kind, text, template,
          reply_to_message_id, idempotency_key, status
        ) VALUES (
          ${input.appId}, ${input.contactId}, ${input.appUserId},
          ${input.channel}, ${input.kind}, ${input.text},
          ${input.template === null ? null : JSON.stringify(input.template)}::jsonb,
          ${input.replyToMessageId}, ${input.idempotencyKey}, 'sending'
        )
        ON CONFLICT (app_id, idempotency_key) DO UPDATE
        SET status = 'sending',
            error = NULL,
            provider_message_id = NULL
        WHERE outbound_messages.status = 'failed'
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      return fila ? aSaliente(fila) : null
    },

    async findByIdempotencyKey(appId, idempotencyKey) {
      const filas = (await sql`
        SELECT * FROM outbound_messages
        WHERE app_id = ${appId} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `) as Fila[]
      const fila = filas[0]
      return fila ? aSaliente(fila) : null
    },

    async marcarEnviado(id, providerMessageId) {
      await sql`
        UPDATE outbound_messages
        SET status = 'sent',
            provider_message_id = ${providerMessageId},
            error = NULL
        WHERE id = ${id}
      `
    },

    async marcarFallido(id, error) {
      await sql`
        UPDATE outbound_messages
        SET status = 'failed', error = ${error}
        WHERE id = ${id}
      `
    },
  }
}
```

- [ ] **Step 5: Escribir el doble de test**

Agregá a `src/test-support/fake-repos.ts` (y sumá `OutboundMessage` y `OutboundMessagesRepo` al import de tipos de arriba del archivo):

```ts
export function unSaliente(
  over: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    id: 'out-1',
    appId: 'app-1',
    contactId: 'contact-1',
    appUserId: 'user-1',
    channel: 'telegram',
    kind: 'reply',
    text: 'anotado: banca 4x10 60',
    template: null,
    replyToMessageId: null,
    providerMessageId: null,
    status: 'sending',
    error: null,
    idempotencyKey: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    ...over,
  }
}

export function createFakeOutboundMessagesRepo(
  inicial: OutboundMessage[] = [],
): OutboundMessagesRepo {
  // Copias, no referencias, igual que en el doble de entrantes: el repositorio
  // real emite SQL y no puede mutar el objeto que el llamador tiene en la mano.
  const mensajes = inicial.map((m) => ({ ...m }))
  let siguienteId = inicial.length + 1

  return {
    async claim(input) {
      const existente =
        input.idempotencyKey === null
          ? undefined
          : mensajes.find(
              (m) =>
                m.appId === input.appId &&
                m.idempotencyKey === input.idempotencyKey,
            )

      if (existente) {
        // Solo lo fallido se vuelve a tomar, y conserva su contenido original.
        if (existente.status !== 'failed') return null
        existente.status = 'sending'
        existente.error = null
        existente.providerMessageId = null
        return { ...existente }
      }

      const creado: OutboundMessage = {
        id: `out-${siguienteId++}`,
        providerMessageId: null,
        status: 'sending',
        error: null,
        createdAt: '2026-08-01T12:00:00.000Z',
        ...input,
      }
      mensajes.push(creado)
      return { ...creado }
    },

    async findByIdempotencyKey(appId, idempotencyKey) {
      const m = mensajes.find(
        (x) => x.appId === appId && x.idempotencyKey === idempotencyKey,
      )
      return m ? { ...m } : null
    },

    async marcarEnviado(id, providerMessageId) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.status = 'sent'
      m.providerMessageId = providerMessageId
      m.error = null
    },

    async marcarFallido(id, error) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.status = 'failed'
      m.error = error
    },
  }
}
```

- [ ] **Step 6: Correr los tests**

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" bun run test src/db/repositories/outbound-messages.integration.test.ts
```

Esperado: PASS, 7 tests.

```bash
DATABASE_URL='' bun run test src/db/repositories/outbound-messages.integration.test.ts
```

Esperado: `skipped`, exit 0.

- [ ] **Step 7: Verificar el resto y commitear**

```bash
bun run typecheck
```

```bash
bun run lint
```

```bash
bun run test
```

```bash
git add src/db/ src/test-support/fake-repos.ts
git commit -m "feat: repositorio de outbound_messages con reserva atomica"
```

---

## Task 4: El cliente de Telegram aprende a responder

`OutgoingMessage` tiene `replyToMessageId` desde el spec. Aceptarlo en la API y no pasárselo a Telegram sería mentir en silencio.

**Files:**
- Modify: `src/channels/telegram/client.ts`, `src/channels/telegram/client.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregá estos tres tests dentro del `describe('createTelegramClient', ...)` de `src/channels/telegram/client.test.ts`, después del primero:

```ts
  it('manda reply_parameters cuando se responde a un mensaje', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 78 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'dale', '55')

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'dale',
      reply_parameters: {
        message_id: 55,
        // Si el usuario borró el mensaje original, el envío tiene que salir
        // igual: perder la respuesta por eso sería peor que perder el hilo.
        allow_sending_without_reply: true,
      },
    })
  })

  it('no manda reply_parameters si no hay a qué responder', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 79 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola', null)

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('ignora un replyToMessageId que no es un número', async () => {
    // Telegram exige un entero. Mandarle basura hace fallar el envío entero;
    // mandarlo sin reply llega, que es lo que importa.
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 80 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola', 'no-es-un-numero')

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/channels/telegram/client.test.ts
```

Esperado: FAIL — el cuerpo posteado no tiene `reply_parameters`.

- [ ] **Step 3: Escribir la implementación**

Reemplazá `src/channels/telegram/client.ts` entero:

```ts
export interface TelegramClient {
  sendMessage(
    token: string,
    chatId: string,
    text: string,
    replyToMessageId?: string | null,
  ): Promise<{ messageId: string }>
}

export type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Telegram pide un entero. Un id que no lo sea se descarta en vez de romper el
 * envío: el mensaje sin hilo llega, y el mensaje rechazado no.
 */
function replyParameters(
  replyToMessageId: string | null | undefined,
): Record<string, unknown> {
  if (replyToMessageId === null || replyToMessageId === undefined) return {}
  const numero = Number(replyToMessageId)
  if (!Number.isInteger(numero)) return {}
  return {
    reply_parameters: {
      message_id: numero,
      allow_sending_without_reply: true,
    },
  }
}

export function createTelegramClient(fetchImpl: Fetch = fetch): TelegramClient {
  return {
    async sendMessage(token, chatId, text, replyToMessageId) {
      const res = await fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...replyParameters(replyToMessageId),
          }),
        },
      )

      const cuerpo = (await res.json().catch(() => null)) as {
        ok?: boolean
        result?: { message_id?: number }
        description?: string
      } | null

      if (!res.ok || cuerpo?.ok !== true) {
        // El token va en la URL: nunca se incluye el detalle de la request en
        // el error, solo la descripción que devuelve Telegram.
        throw new Error(
          `Telegram rechazó sendMessage: ${cuerpo?.description ?? res.status}`,
        )
      }

      return { messageId: String(cuerpo.result?.message_id ?? '') }
    },
  }
}
```

El cuarto parámetro es opcional, así que el `responder` del webhook de la fase 1 sigue compilando y comportándose igual.

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/channels/telegram/client.test.ts src/routes/telegram-webhook.test.ts
```

Esperado: PASS, 6 tests en `client.test.ts` y los del webhook sin cambios.

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram/
git commit -m "feat: el cliente de Telegram soporta responder a un mensaje"
```

---

## Task 5: El caso de uso `enviarSaliente`

El corazón de la fase. Resuelve, reserva, manda, marca — en ese orden, y el orden es el punto.

**Files:**
- Create: `src/outbound/send.ts`
- Test: `src/outbound/send.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/outbound/send.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact, OutboundMessage } from '../db/ports.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unBot,
  unContacto,
  unSaliente,
} from '../test-support/fake-repos.js'
import type { PedidoSaliente } from './send.js'
import { enviarSaliente } from './send.js'

const APP_ID = 'app-1'

function unPedido(over: Partial<PedidoSaliente> = {}): PedidoSaliente {
  return {
    userId: 'user-1',
    text: 'anotado: banca 4x10 60',
    kind: 'reply',
    replyToMessageId: null,
    template: null,
    idempotencyKey: null,
    ...over,
  }
}

function armar(
  opts: {
    contactos?: Contact[]
    bots?: Bot[]
    salientes?: OutboundMessage[]
    fallas?: number
  } = {},
) {
  const enviados: {
    token: string
    chatId: string
    text: string
    replyToMessageId: string | null | undefined
  }[] = []
  let fallasRestantes = opts.fallas ?? 0

  const telegram: TelegramClient = {
    async sendMessage(token, chatId, text, replyToMessageId) {
      enviados.push({ token, chatId, text, replyToMessageId })
      if (fallasRestantes > 0) {
        fallasRestantes -= 1
        throw new Error('Telegram rechazó sendMessage: chat not found')
      }
      return { messageId: `tg-${enviados.length}` }
    },
  }

  const outbound = createFakeOutboundMessagesRepo(opts.salientes ?? [])

  return {
    enviados,
    outbound,
    deps: {
      bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
      contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
      outbound,
      telegram,
      // Devolver el nombre permite comprobar que el token salió de
      // bots.token_env y no de otro lado.
      secrets: (nombre: string) => `valor-de-${nombre}`,
    },
  }
}

describe('enviarSaliente', () => {
  it('manda al chat del contacto con el token del bot de la app', async () => {
    const { deps, enviados } = armar()

    const resultado = await enviarSaliente(deps, APP_ID, unPedido())

    expect(resultado.estado).toBe('sent')
    expect(enviados[0]?.token).toBe('valor-de-TELEGRAM_TOKEN_GYM')
    expect(enviados[0]?.chatId).toBe('12345')
    expect(enviados[0]?.text).toBe('anotado: banca 4x10 60')
  })

  it('devuelve el id del proveedor y deja la fila en sent', async () => {
    const { deps, outbound } = armar()

    const resultado = await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ idempotencyKey: 'k-1' }),
    )

    if (resultado.estado !== 'sent') throw new Error('no se envió')
    expect(resultado.providerMessageId).toBe('tg-1')

    const guardado = await outbound.findByIdempotencyKey(APP_ID, 'k-1')
    expect(guardado?.status).toBe('sent')
    expect(guardado?.providerMessageId).toBe('tg-1')
  })

  it('guarda kind, template y el mensaje al que responde', async () => {
    const { deps, outbound, enviados } = armar()

    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({
        kind: 'notification',
        template: { name: 'checkin', vars: { hora: '22:00' } },
        replyToMessageId: '55',
        idempotencyKey: 'k-2',
      }),
    )

    const guardado = await outbound.findByIdempotencyKey(APP_ID, 'k-2')
    expect(guardado?.kind).toBe('notification')
    expect(guardado?.template).toEqual({
      name: 'checkin',
      vars: { hora: '22:00' },
    })
    expect(enviados[0]?.replyToMessageId).toBe('55')
  })

  it('no manda nada si el usuario no está vinculado', async () => {
    const { deps, enviados } = armar({ contactos: [] })

    expect((await enviarSaliente(deps, APP_ID, unPedido())).estado).toBe(
      'not_linked',
    )
    expect(enviados).toEqual([])
  })

  it('no manda nada si la app no tiene bot activo en el canal', async () => {
    const { deps, enviados } = armar({ bots: [unBot({ active: false })] })

    expect((await enviarSaliente(deps, APP_ID, unPedido())).estado).toBe(
      'no_bot',
    )
    expect(enviados).toEqual([])
  })

  it('con la misma clave manda una sola vez y repite la respuesta', async () => {
    // Es la capa 3 de idempotencia del spec: la app reintenta y no se manda
    // dos veces.
    const { deps, enviados } = armar()
    const pedido = unPedido({ idempotencyKey: 'k-3' })

    const primero = await enviarSaliente(deps, APP_ID, pedido)
    const segundo = await enviarSaliente(deps, APP_ID, pedido)

    expect(enviados).toHaveLength(1)
    expect(primero.estado).toBe('sent')
    expect(segundo.estado).toBe('duplicate')
    if (primero.estado !== 'sent' || segundo.estado !== 'duplicate') {
      throw new Error('estados inesperados')
    }
    expect(segundo.providerMessageId).toBe(primero.providerMessageId)
    expect(segundo.mensaje.id).toBe(primero.mensaje.id)
  })

  it('sin clave, dos llamadas iguales mandan dos mensajes', async () => {
    // La idempotencia es opt-in: sin clave no hay nada que deduplicar, y
    // suprimir el segundo envío sería adivinar.
    const { deps, enviados } = armar()

    await enviarSaliente(deps, APP_ID, unPedido())
    await enviarSaliente(deps, APP_ID, unPedido())

    expect(enviados).toHaveLength(2)
  })

  it('marca fallido y no explota si Telegram rechaza', async () => {
    const { deps, outbound } = armar({ fallas: 1 })

    const resultado = await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ idempotencyKey: 'k-4' }),
    )

    expect(resultado.estado).toBe('send_failed')
    if (resultado.estado !== 'send_failed') throw new Error('estado inesperado')
    expect(resultado.error).toMatch(/chat not found/)

    const guardado = await outbound.findByIdempotencyKey(APP_ID, 'k-4')
    expect(guardado?.status).toBe('failed')
    expect(guardado?.providerMessageId).toBeNull()
  })

  it('reintentar con la misma clave después de un fallo sí manda', async () => {
    // Un envío fallido nunca llegó al chat, así que la clave no tiene nada que
    // proteger: bloquear el reintento dejaría a la app sin salida.
    const { deps, enviados } = armar({ fallas: 1 })
    const pedido = unPedido({ idempotencyKey: 'k-5' })

    expect((await enviarSaliente(deps, APP_ID, pedido)).estado).toBe(
      'send_failed',
    )
    expect((await enviarSaliente(deps, APP_ID, pedido)).estado).toBe('sent')
    expect(enviados).toHaveLength(2)
  })

  it('un envío en vuelo con la misma clave devuelve in_progress', async () => {
    // La fila quedó en `sending` porque la invocación anterior se murió entre
    // la reserva y la marca. No sabemos si el mensaje salió: mandarlo de nuevo
    // podría duplicarlo, así que se avisa y decide la app.
    const { deps, enviados } = armar({
      salientes: [
        unSaliente({ id: 'out-99', status: 'sending', idempotencyKey: 'k-6' }),
      ],
    })

    const resultado = await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ idempotencyKey: 'k-6' }),
    )

    expect(resultado.estado).toBe('in_progress')
    expect(enviados).toEqual([])
  })

  it('reenvía el texto reservado, no el del pedido nuevo', async () => {
    const { deps, enviados } = armar({ fallas: 1 })

    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ text: 'el original', idempotencyKey: 'k-7' }),
    )
    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ text: 'otro texto', idempotencyKey: 'k-7' }),
    )

    expect(enviados[1]?.text).toBe('el original')
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/outbound/send.test.ts
```

Esperado: FAIL — `Cannot find module './send.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/outbound/send.ts`:

```ts
import type { TelegramClient } from '../channels/telegram/client.js'
import type {
  BotsRepo,
  Channel,
  ContactsRepo,
  OutboundKind,
  OutboundMessage,
  OutboundMessagesRepo,
  OutboundTemplate,
} from '../db/ports.js'
import type { SecretReader } from '../secrets.js'

/** v1 es solo Telegram, igual que el resto de las rutas de /v1. */
const CANAL: Channel = 'telegram'

export interface SendDeps {
  bots: BotsRepo
  contacts: ContactsRepo
  outbound: OutboundMessagesRepo
  telegram: TelegramClient
  secrets: SecretReader
}

export interface PedidoSaliente {
  userId: string
  text: string
  kind: OutboundKind
  replyToMessageId: string | null
  template: OutboundTemplate | null
  idempotencyKey: string | null
}

export type ResultadoSaliente =
  | { estado: 'sent'; mensaje: OutboundMessage; providerMessageId: string }
  | { estado: 'duplicate'; mensaje: OutboundMessage; providerMessageId: string }
  | { estado: 'in_progress' }
  | { estado: 'not_linked' }
  | { estado: 'no_bot' }
  | { estado: 'send_failed'; mensaje: OutboundMessage; error: string }

export async function enviarSaliente(
  deps: SendDeps,
  appId: string,
  pedido: PedidoSaliente,
): Promise<ResultadoSaliente> {
  // La app manda un app_user_id y comm-tool lo convierte en un chat_id que la
  // app nunca ve. Ese corte es toda la razón de ser de este servicio.
  const contacto = await deps.contacts.findByAppUserId(
    appId,
    CANAL,
    pedido.userId,
  )
  if (!contacto) return { estado: 'not_linked' }

  const bot = await deps.bots.findByAppAndChannel(appId, CANAL)
  if (!bot) return { estado: 'no_bot' }

  const reservado = await deps.outbound.claim({
    appId,
    contactId: contacto.id,
    appUserId: contacto.appUserId,
    channel: CANAL,
    kind: pedido.kind,
    text: pedido.text,
    template: pedido.template,
    replyToMessageId: pedido.replyToMessageId,
    idempotencyKey: pedido.idempotencyKey,
  })

  if (!reservado) return await resolverClaveTomada(deps, appId, pedido)

  try {
    // Se manda lo que dice la FILA, no lo que dice el pedido: así un reintento
    // sobre una clave ya usada reenvía exactamente el mismo mensaje.
    const { messageId } = await deps.telegram.sendMessage(
      deps.secrets(bot.tokenEnv),
      contacto.externalId,
      reservado.text,
      reservado.replyToMessageId,
    )
    await deps.outbound.marcarEnviado(reservado.id, messageId)
    return { estado: 'sent', mensaje: reservado, providerMessageId: messageId }
  } catch (error) {
    const detalle = (error as Error).message
    await deps.outbound.marcarFallido(reservado.id, detalle)
    return { estado: 'send_failed', mensaje: reservado, error: detalle }
  }
}

/**
 * La reserva no fue nuestra. O el mensaje ya se mandó —y hay que devolver el
 * mismo resultado que la primera vez— o hay un envío en vuelo y no se puede
 * saber si salió.
 */
async function resolverClaveTomada(
  deps: SendDeps,
  appId: string,
  pedido: PedidoSaliente,
): Promise<ResultadoSaliente> {
  if (pedido.idempotencyKey === null) return { estado: 'in_progress' }

  const existente = await deps.outbound.findByIdempotencyKey(
    appId,
    pedido.idempotencyKey,
  )
  if (!existente || existente.status !== 'sent') return { estado: 'in_progress' }

  return {
    estado: 'duplicate',
    mensaje: existente,
    providerMessageId: existente.providerMessageId ?? '',
  }
}
```

Dos cosas que se leen mal si no se explican:

**`findByAppAndChannel` ya filtra por `active`**, así que no hace falta volver a chequearlo acá — a diferencia de `intentarEntrega`, que sí chequea `app.active` porque `findById` no filtra.

**`claim` devuelve `null` con clave nula es imposible** por construcción (sin clave no hay conflicto), pero `resolverClaveTomada` lo contempla igual: si algún día ocurriera, `in_progress` es la respuesta segura, no un envío duplicado.

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/outbound/send.test.ts
```

Esperado: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/outbound/
git commit -m "feat: caso de uso de envio saliente con idempotencia"
```

---

## Task 6: La ruta `POST /v1/messages`

**Files:**
- Create: `src/routes/messages.ts`
- Test: `src/routes/messages.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/routes/messages.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unApp,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { messageRoutes } from './messages.js'

function armar(
  opts: { contactos?: Contact[]; bots?: Bot[]; falla?: boolean } = {},
) {
  const telegram: TelegramClient = {
    async sendMessage() {
      if (opts.falla) {
        throw new Error('Telegram rechazó sendMessage: chat not found')
      }
      return { messageId: 'tg-1' }
    },
  }

  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route(
    '/',
    messageRoutes({
      bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
      contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
      outbound: createFakeOutboundMessagesRepo([]),
      telegram,
      secrets: () => 'token',
    }),
  )
  return server
}

function postear(server: Hono<ConVariablesDeApp>, cuerpo: unknown) {
  return server.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
}

const VALIDO = { userId: 'user-1', text: 'hola', kind: 'reply' }

describe('POST /v1/messages', () => {
  it('manda y devuelve los dos ids', async () => {
    const res = await postear(armar(), VALIDO)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messageId: 'out-1',
      providerMessageId: 'tg-1',
      status: 'sent',
    })
  })

  it('nunca devuelve el chat_id', async () => {
    const server = armar({
      contactos: [unContacto({ appUserId: 'user-1', externalId: '987654' })],
    })
    const cuerpo = await (await postear(server, VALIDO)).text()
    expect(cuerpo).not.toContain('987654')
  })

  it('rechaza un cuerpo sin los campos obligatorios', async () => {
    for (const malo of [
      {},
      { userId: 'user-1', text: 'hola' },
      { userId: 'user-1', kind: 'reply' },
      { userId: '', text: 'hola', kind: 'reply' },
      { userId: 'user-1', text: '', kind: 'reply' },
      { userId: 'user-1', text: 'hola', kind: 'grito' },
    ]) {
      const res = await postear(armar(), malo)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ code: 'invalid_request' })
    }
  })

  it('rechaza un texto más largo de lo que Telegram acepta', async () => {
    const res = await postear(armar(), { ...VALIDO, text: 'a'.repeat(4097) })
    expect(res.status).toBe(400)
  })

  it('devuelve 404 not_linked si el usuario no vinculó', async () => {
    const res = await postear(armar({ contactos: [] }), VALIDO)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'not_linked' })
  })

  it('devuelve 502 si el proveedor rechaza', async () => {
    const res = await postear(armar({ falla: true }), VALIDO)

    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'send_failed' })
  })

  it('devuelve 500 si la app no tiene bot configurado', async () => {
    // No es culpa del request: es configuración nuestra que falta.
    const res = await postear(armar({ bots: [] }), VALIDO)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ code: 'no_bot' })
  })

  it('repite la misma respuesta ante la misma clave de idempotencia', async () => {
    const server = armar()
    const cuerpo = { ...VALIDO, idempotencyKey: 'k-1' }

    const primera = await (await postear(server, cuerpo)).json()
    const segunda = await (await postear(server, cuerpo)).json()

    expect(segunda).toEqual(primera)
  })

  it('acepta y guarda el template sin usarlo en Telegram', async () => {
    const res = await postear(armar(), {
      ...VALIDO,
      kind: 'notification',
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/routes/messages.test.ts
```

Esperado: FAIL — `Cannot find module './messages.js'`.

- [ ] **Step 3: Escribir la ruta**

`src/routes/messages.ts`:

```ts
import { Hono } from 'hono'
import * as z from 'zod'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import type { SendDeps } from '../outbound/send.js'
import { enviarSaliente } from '../outbound/send.js'

/**
 * Telegram corta los mensajes de texto en 4096 caracteres. Validarlo acá
 * convierte un 502 del proveedor en un 400 con causa clara.
 */
const LARGO_MAXIMO_TEXTO = 4096

const cuerpoSchema = z.object({
  userId: z.string().min(1),
  text: z.string().min(1).max(LARGO_MAXIMO_TEXTO),
  kind: z.enum(['reply', 'notification']),
  replyToMessageId: z.string().min(1).optional(),
  template: z
    .object({
      name: z.string().min(1),
      vars: z.record(z.string(), z.string()),
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

export function messageRoutes(deps: SendDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.post('/v1/messages', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = cuerpoSchema.safeParse(crudo)
    if (!parseado.success) {
      return c.json({ code: 'invalid_request' }, 400)
    }

    const app = c.get('app')
    const resultado = await enviarSaliente(deps, app.id, {
      userId: parseado.data.userId,
      text: parseado.data.text,
      kind: parseado.data.kind,
      replyToMessageId: parseado.data.replyToMessageId ?? null,
      template: parseado.data.template ?? null,
      idempotencyKey: parseado.data.idempotencyKey ?? null,
    })

    switch (resultado.estado) {
      // Un duplicado contesta lo mismo que el original, con el mismo código:
      // para la app, reintentar tiene que ser indistinguible de acertar a la
      // primera.
      case 'sent':
      case 'duplicate':
        return c.json({
          messageId: resultado.mensaje.id,
          providerMessageId: resultado.providerMessageId,
          status: 'sent',
        })
      case 'not_linked':
        return c.json({ code: 'not_linked' }, 404)
      case 'in_progress':
        // La reserva anterior nunca se cerró. No se puede saber si el mensaje
        // salió, así que se avisa en vez de arriesgar un duplicado.
        return c.json({ code: 'in_progress' }, 409)
      case 'no_bot':
        return c.json({ code: 'no_bot' }, 500)
      case 'send_failed':
        return c.json(
          {
            code: 'send_failed',
            messageId: resultado.mensaje.id,
            error: resultado.error,
          },
          502,
        )
    }
  })

  return rutas
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/routes/messages.test.ts
```

Esperado: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages.ts src/routes/messages.test.ts
git commit -m "feat: POST /v1/messages"
```

---

## Task 7: Cableado

**Files:**
- Modify: `src/create-app.ts`, `src/index.ts`, `src/test-support/fake-deps.ts`

- [ ] **Step 1: Extender `Deps` y montar la ruta**

En `src/create-app.ts`, sumá `OutboundMessagesRepo` al import de tipos de `./db/ports.js`, sumá el import de la ruta:

```ts
import { messageRoutes } from './routes/messages.js'
```

sumá el campo a `Deps`, después de `inbound`:

```ts
  outbound: OutboundMessagesRepo
```

y montá la ruta dentro del bloque de `/v1`, junto a las otras:

```ts
  v1.route('/', messageRoutes(deps))
```

- [ ] **Step 2: Completar las dependencias falsas**

En `src/test-support/fake-deps.ts`, sumá `createFakeOutboundMessagesRepo` al import de `./fake-repos.js` y agregá al objeto que devuelve `createFakeDeps`, después de `inbound`:

```ts
    outbound: createFakeOutboundMessagesRepo([]),
```

- [ ] **Step 3: Armar la dependencia real**

En `src/index.ts`, sumá el import:

```ts
import { createOutboundMessagesRepo } from './db/repositories/outbound-messages.js'
```

y la entrada, después de `inbound`:

```ts
  outbound: createOutboundMessagesRepo(sql),
```

- [ ] **Step 4: Verificar que la ruta exige API key**

Agregá este test al final de `src/routes/messages.test.ts`, con `createFakeDeps` importado de `../test-support/fake-deps.js` y `createApp` de `../create-app.js`:

```ts
describe('POST /v1/messages montado en la app completa', () => {
  it('devuelve 401 sin Authorization', async () => {
    const app = createApp(createFakeDeps())
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALIDO),
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 5: Verificar todo junto**

```bash
bun run typecheck
```

```bash
bun run lint
```

```bash
bun run test
```

```bash
DATABASE_URL='' bun run test
```

Esperado: los primeros tres en verde, y el último con **4** archivos de integración salteados.

- [ ] **Step 6: Verificar el entrypoint del build**

El preset de Hono de Vercel elige el entrypoint por convención y rompe en runtime con todo verde localmente. Ver CLAUDE.md, §Gotchas del tooling.

```bash
bun --bun x vercel build --yes >/dev/null 2>&1 && grep handler .vercel/output/functions/index.func/.vc-config.json
```

Esperado: `"handler": "src/index.js"`.

- [ ] **Step 7: Commit**

```bash
git add src/create-app.ts src/index.ts src/test-support/fake-deps.ts src/routes/messages.test.ts
git commit -m "feat: cableado de los salientes"
```

---

## Task 8: Verificación local de punta a punta

Acá el mensaje llega a un Telegram de verdad. Es la prueba que ninguna suite reemplaza.

**Requiere al usuario:** hay que mandarle un mensaje al bot desde la app de Telegram.

- [ ] **Step 1: Levantar el servicio**

```bash
PORT=3987 bun run dev
```

Dejalo corriendo en una terminal aparte.

- [ ] **Step 2: Conseguir una API key de `gym-tracker`**

**La API key no está en el `.env`, y no es un descuido:** los cinco secretos que baja `vercel env pull` son de comm-tool, y la API key es credencial de la *app consumidora* — acá solo vive su hash. Para verificar a mano hace falta una en claro, así que se genera una nueva y se rota:

```bash
KEY="$(openssl rand -hex 24)" && echo "GYM_API_KEY=$KEY" >> .env && bun run scripts/registrar-app.ts "$KEY"
```

Esperado: `app gym-tracker: <uuid>`.

Rotar es inofensivo hoy porque **ningún consumidor usa la clave todavía** — GymTracker se conecta recién en la fase 4. Ojo: `vercel env pull .env` pisa el archivo entero, así que después de un pull hay que volver a correr esto.

- [ ] **Step 3: Emitir un código de vinculación**

```bash
curl -s -X POST localhost:3987/v1/link-codes \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' -d '{"userId":"local-1"}'
```

Esperado: `{"code":"ABC123","expiresAt":"...","length":6}`.

- [ ] **Step 4: Vincular desde Telegram de verdad**

Desde tu Telegram, mandale a `@gymtrackerjaddbot`:

```
/vincular ABC123
```

Ese mensaje va al webhook de **producción** (así está registrado en Telegram), pero la base es la misma, así que el contacto queda visible desde localhost. Esperado en el chat: `Listo, tu cuenta quedó vinculada.`

**Ojo con el efecto de borde:** a partir de acá cada mensaje que le mandes al bot se intenta entregar al `delivery_url` de `gym-tracker`, que todavía no existe. Van a acumularse entregas fallidas hasta que el paso 9 desvincule. Es ruido esperado, no un problema.

- [ ] **Step 5: Mandar un saliente**

```bash
curl -s -X POST localhost:3987/v1/messages \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"local-1","text":"Hola desde communication-tool","kind":"notification"}'
```

Esperado: `{"messageId":"<uuid>","providerMessageId":"<numero>","status":"sent"}` **y el mensaje en tu Telegram**.

Verificá que la respuesta no contenga tu `chat_id`: hay `messageId` y `providerMessageId`, no hay `chatId` ni `externalId`.

- [ ] **Step 6: Probar la idempotencia**

```bash
curl -s -X POST localhost:3987/v1/messages \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"local-1","text":"Este tiene clave","kind":"notification","idempotencyKey":"prueba-1"}'
```

Corré **exactamente el mismo comando una segunda vez**. Esperado: la misma respuesta, byte por byte, y **un solo mensaje** en el chat.

- [ ] **Step 7: Probar responder a un mensaje**

Tomá el `providerMessageId` que devolvió el paso 5 y usalo como `replyToMessageId`:

```bash
curl -s -X POST localhost:3987/v1/messages \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"local-1","text":"Y esto responde al anterior","kind":"reply","replyToMessageId":"<PROVIDER_MESSAGE_ID>"}'
```

Esperado: el mensaje aparece en Telegram **citando** al del paso 5.

- [ ] **Step 8: Probar `not_linked`**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3987/v1/messages \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"nadie","text":"hola","kind":"reply"}'
```

Esperado: `404`.

- [ ] **Step 9: Mirar el log y limpiar**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); const r=await c.query(\"SELECT app_user_id, kind, left(text,30) AS texto, status, provider_message_id, idempotency_key FROM outbound_messages ORDER BY created_at\"); console.table(r.rows); await c.end()"
```

Esperado: cuatro filas en `sent` —dos sin clave, una con `prueba-1`, una respondiendo— y ninguna repetida.

Desvinculá para volver al estado previo, así no quedan entregas entrantes intentándose contra un endpoint que no existe:

```bash
curl -s -X DELETE localhost:3987/v1/contacts/local-1 \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)"
```

Esperado: `{"unlinked":true}`.

---

## Task 9: Verificación en producción

- [ ] **Step 1: Abrir el PR y mergear**

```bash
git push -u origin HEAD
```

```bash
gh pr create --title "Fase 3: salientes" --body "Implementa \`POST /v1/messages\`, \`outbound_messages\` e idempotencia por \`(app_id, idempotency_key)\`. Plan: \`docs/superpowers/plans/2026-08-01-phase-3-outbound.md\`."
```

Esperá el CI en verde y mergeá. Vercel deploya main solo.

**Esta fase no agrega variables de entorno**, así que no hay que cargar nada ni forzar un redeploy por configuración.

- [ ] **Step 2: Confirmar que la migración corrió contra producción**

La migración se aplicó a mano en la Task 1 y la base es la misma, así que solo hay que confirmarlo:

```bash
bun run db:migrate
```

Esperado: `Sin migraciones pendientes (3 aplicadas).`

- [ ] **Step 3: Verificar la autenticación en producción**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://communication-tool-beta.vercel.app/v1/messages \
  -H 'Content-Type: application/json' -d '{"userId":"x","text":"y","kind":"reply"}'
```

Esperado: `401`.

- [ ] **Step 4: Verificar `not_linked` en producción**

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/v1/messages \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"nadie","text":"hola","kind":"reply"}'
```

Esperado: `{"code":"not_linked"}` con estado 404.

- [ ] **Step 5: Un envío real desde producción**

Emitir un código contra producción:

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/v1/link-codes \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' -d '{"userId":"prod-1"}'
```

Mandale `/vincular <EL_CODIGO>` al bot desde tu Telegram, esperá el `Listo, tu cuenta quedó vinculada.` y después:

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/v1/messages \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"prod-1","text":"Saliente desde produccion","kind":"notification","idempotencyKey":"prod-1-a"}'
```

Repetí el comando idéntico. Esperado: dos respuestas iguales, **un solo mensaje** en Telegram.

- [ ] **Step 6: Desvincular y confirmar el estado final**

```bash
curl -s -X DELETE https://communication-tool-beta.vercel.app/v1/contacts/prod-1 \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)"
```

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); const o=await c.query('SELECT status, count(*)::text FROM outbound_messages GROUP BY 1 ORDER BY 1'); console.log('salientes:'); console.table(o.rows); const i=await c.query('SELECT delivery_status, count(*)::text FROM inbound_messages GROUP BY 1 ORDER BY 1'); console.log('entrantes:'); console.table(i.rows); await c.end()"
```

Esperado en salientes: todo en `sent`, **nada en `sending`**. Una fila trabada en `sending` significa que una invocación se murió entre la reserva y la marca — anotarlo, no ignorarlo.

---

## Task 10: Cerrar la fase en la documentación

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `.env.example`

- [ ] **Step 1: Contar los tests**

```bash
bun run test 2>&1 | tail -5
```

Anotá el total que reporte: va textual en el párrafo del paso siguiente, donde dice `<N>`.

- [ ] **Step 2: Actualizar el estado en `CLAUDE.md`**

En §Estado del proyecto, insertá esto arriba del bloque de la fase 2, y reemplazá `<FECHA>` por la fecha en que corriste la Task 9 y `<N>` por el total del paso anterior:

```markdown
Fase 3 — Salientes **completa** (<FECHA>, verificada contra producción).
`POST /v1/messages` resuelve el contacto por `app_user_id`, saca el token del
bot de la app y manda por Telegram, síncrono. La fila de `outbound_messages`
se **reserva antes** del envío: por eso `status` tiene un tercer valor,
`sending`, que el spec no lista. Idempotencia por `(app_id, idempotency_key)`,
opt-in: sin clave no se deduplica nada. `<N>` tests.

El `replyToMessageId` viaja en ids **del proveedor**, en las dos direcciones,
porque el entrante de la fase 2 ya los expone así. La respuesta devuelve los
dos ids —`messageId` nuestro y `providerMessageId` de Telegram— para que la
fase 4 elija cuál expone la interfaz `Messaging` sin tocar nada de acá.

`409 window_closed` **no está implementado**: depende de la ventana de 24
horas de WhatsApp, que es fase 7. En Telegram no podría dispararse nunca.
```

Y cambiá **Próxima fase** a:

```markdown
**Próxima fase:** Fase 4 — Cliente (paquete npm, suite de conformidad de la
interfaz `Messaging`, **migración de GymTracker**). Generar el plan con
`superpowers:writing-plans` contra el spec.
```

- [ ] **Step 3: Sumar la invariante y la nota de operación**

A §Invariantes de `CLAUDE.md`:

```markdown
- **Un saliente se reserva antes de mandarse.** La fila de `outbound_messages`
  nace en `sending` y recién después se llama al proveedor. Invertir el orden
  haría que dos reintentos solapados manden dos mensajes.
- **Un bot por app y canal**, impuesto por `bots_app_channel_unico`. Sin ese
  índice, "el bot de esta app" depende del orden del `SELECT`.
```

A §Operación:

```markdown
- **La API key de una app no vive en el `.env` de comm-tool**, solo su hash en
  la base. Para probar a mano hay que generar una y rotarla con
  `bun run scripts/registrar-app.ts <api-key>`. Hoy es inofensivo porque
  ningún consumidor la usa todavía.
- **Un saliente trabado en `sending`** es una invocación que murió entre la
  reserva y la marca. Un reintento con la misma clave devuelve `409
  in_progress` a propósito: no se puede saber si el mensaje salió.

  ```sql
  SELECT app_user_id, status, provider_message_id, idempotency_key, error
  FROM outbound_messages ORDER BY created_at DESC LIMIT 20;
  ```
```

- [ ] **Step 4: Documentar `GYM_API_KEY` en `.env.example`**

Agregá al final de `.env.example`:

```bash
# NO es un secreto de comm-tool: es la API key de la app consumidora, que acá
# solo se guarda hasheada en `apps.api_key_hash`. Va en el .env local nada más
# para poder probar los endpoints /v1 a mano. `vercel env pull` pisa el
# archivo y se la lleva puesta; regenerarla con:
#   KEY="$(openssl rand -hex 24)" && echo "GYM_API_KEY=$KEY" >> .env \
#     && bun run scripts/registrar-app.ts "$KEY"
GYM_API_KEY=
```

- [ ] **Step 5: Actualizar el `README.md`**

Reemplazá la sección §Estado, que quedó en la fase 0:

```markdown
## Estado

Fases 0 a 3 completas: scaffold, identidad y vinculación, entrega firmada con
reintentos, y salientes. Ver [`CLAUDE.md`](CLAUDE.md) para el estado detallado,
los gotchas del tooling y las fases siguientes.
```

Y sumá una sección de API antes de §Scripts:

````markdown
## API

| Método | Ruta | Auth |
|---|---|---|
| `POST` | `/v1/messages` | Bearer con la API key de la app |
| `POST` | `/v1/link-codes` | Bearer con la API key de la app |
| `GET` / `DELETE` | `/v1/contacts/:userId` | Bearer con la API key de la app |
| `POST` | `/webhooks/telegram/:botSlug` | `X-Telegram-Bot-Api-Secret-Token` |
| `POST` | `/internal/tick`, `/internal/replay/:messageId` | Bearer con `INTERNAL_SECRET` |
| `GET` | `/health` | — |

`POST /v1/messages` acepta
`{ userId, text, kind, replyToMessageId?, template?, idempotencyKey? }` y
devuelve `{ messageId, providerMessageId, status }`.

| Código | Cuándo |
|---|---|
| `400 invalid_request` | El cuerpo no valida, o el texto pasa los 4096 caracteres |
| `404 not_linked` | Ese `userId` no tiene contacto vinculado |
| `409 in_progress` | Esa `idempotencyKey` tiene un envío sin cerrar |
| `500 no_bot` | La app no tiene bot activo en el canal — configuración faltante |
| `502 send_failed` | El proveedor rechazó el envío |

Repetir la llamada con la misma `idempotencyKey` devuelve la misma respuesta
sin mandar un segundo mensaje. Sin clave no hay deduplicación.
````

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md .env.example
git commit -m "docs: cierre de la fase 3"
```

---

## Verificación de la fase

- [ ] `bun run lint && bun run typecheck && bun run test` en verde.
- [ ] `DATABASE_URL='' bun run test` saltea **4** archivos de integración y sale con 0.
- [ ] CI en verde en GitHub.
- [ ] `bun run db:migrate` reporta `Sin migraciones pendientes (3 aplicadas).`
- [ ] `bun --bun x vercel build --yes` deja `"handler": "src/index.js"`.
- [ ] Un `POST /v1/messages` con un usuario vinculado **llega al Telegram real**.
- [ ] La respuesta trae `messageId` y `providerMessageId`, y **no** trae `chatId` ni `externalId`.
- [ ] Repetir la llamada con la misma `idempotencyKey` devuelve la misma respuesta y **no** produce un segundo mensaje en el chat.
- [ ] Sin `idempotencyKey`, dos llamadas iguales sí producen dos mensajes.
- [ ] Un `userId` sin contacto devuelve **404 `not_linked`**.
- [ ] `POST /v1/messages` sin `Authorization` devuelve **401** en producción.
- [ ] Un `replyToMessageId` válido hace que Telegram muestre el mensaje citando al anterior.
- [ ] No queda ninguna fila en `sending` al terminar.

El que cierra la fase es el de la clave repetida: prueba que **la app puede reintentar sin miedo**, que es la razón entera por la que esta fase existe. El resto —mandar un mensaje— ya lo sabía hacer el webhook desde la fase 1.
