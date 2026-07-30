# communication-tool — Fase 2: Entrega

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un mensaje de un chat vinculado llegue efectivamente a la app dueña, firmado, con reintentos, y sin perderse nunca aunque la app esté caída.

**Architecture:** El webhook persiste el mensaje crudo **antes** de contestarle 200 a Telegram, y la entrega ocurre después de la respuesta mediante un `waitUntil` inyectado. Un intento de entrega es una función que lee un mensaje, lo firma, lo postea y actualiza su estado; el webhook la llama con un reintento inmediato a los 10 segundos, y el ticker externo la llama para los intentos lentos. Toda la lógica frágil —firma HMAC, cálculo del backoff, decisión de reintentar o rendirse— vive en módulos puros con TDD.

**Tech Stack:** Hono, Bun, TypeScript, Zod, `@neondatabase/serverless`, `@vercel/functions`, Vitest, Neon.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## Alcance de esta fase

Del spec, §Fases: «Entrega — `inbound_messages`, delivery con HMAC, reintentos, `/internal/tick`, replay manual».

**Entra:** la tabla `inbound_messages`, la persistencia del crudo antes del ack, la deduplicación por `(bot_id, provider_update_id)`, la entrega firmada al `delivery_url` de la app, el backoff de 5 intentos, el endpoint `/internal/tick` que procesa los reintentos lentos, y `/internal/replay/:messageId` para reprocesar a mano.

**No entra, y es deliberado:**

- **`POST /v1/messages` y `outbound_messages`.** Son la fase 3. Esta fase solo mueve mensajes hacia la app; el camino de vuelta todavía es el cliente interno de Telegram que usa `/vincular`.
- **`schedules` y los programados.** Fase 5. El ticker que se monta acá existe **solo** para los reintentos; la fase 5 le suma el disparo de programados sobre el mismo endpoint.
- **WhatsApp.** El campo `channel` se llena con `'telegram'` y nada más lo lee todavía.

**Y una dependencia que no se puede cerrar sola:** la entrega necesita que exista un endpoint del otro lado. GymTracker todavía no lo tiene — es su fase 3. La Task 11 verifica la entrega contra un receptor de prueba, no contra GymTracker.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/0002_inbound_messages.sql` | La tabla y su índice de pendientes |
| `src/delivery/signature.ts` | Firma HMAC del payload. **Puro** |
| `src/delivery/backoff.ts` | Cuándo toca el próximo intento, o rendirse. **Puro** |
| `src/delivery/client.ts` | POST al `delivery_url` con timeout |
| `src/delivery/deliver.ts` | Un intento de entrega y la actualización de estado |
| `src/db/repositories/inbound-messages.ts` | `InboundMessagesRepo` sobre Neon |
| `src/middleware/internal-auth.ts` | Bearer para `/internal/*` |
| `src/routes/internal.ts` | `/internal/tick` y `/internal/replay/:messageId` |
| `src/routes/telegram-webhook.ts` | **Modificar**: persistir, deduplicar, entregar |
| `src/db/ports.ts` | **Modificar**: `InboundMessagesRepo`, `AppsRepo.findById` |
| `src/env.ts` | **Modificar**: `INTERNAL_SECRET` |
| `src/create-app.ts` | **Modificar**: `Deps` crece con `waitUntil` y `sleep` |

**El corte que sostiene la fase:** `intentarEntrega` no sabe si la llamó el webhook o el ticker. Esa indiferencia es lo que hace que el reintento inmediato y el lento compartan una sola implementación probada.

---

## Task 1: Migración de `inbound_messages`

**Files:**
- Create: `migrations/0002_inbound_messages.sql`

- [ ] **Step 1: Escribir la migración**

`migrations/0002_inbound_messages.sql`:

```sql
CREATE TABLE inbound_messages (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id             uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  app_id             uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  channel            text        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  provider_update_id text        NOT NULL,
  external_id        text        NOT NULL,
  app_user_id        text,
  text               text        NOT NULL DEFAULT '',
  reply_to_message_id text,
  raw                jsonb       NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  delivery_status    text        NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'skipped')),
  delivery_attempts  int         NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  delivered_at       timestamptz,
  last_error         text,
  UNIQUE (bot_id, provider_update_id)
);

-- Índice parcial: el ticker solo pregunta por pendientes vencidos, y en un
-- historial largo los entregados son el 99%.
CREATE INDEX inbound_messages_pendientes_idx
  ON inbound_messages (next_attempt_at)
  WHERE delivery_status = 'pending';
```

**`app_user_id` se guarda desnormalizado, no se resuelve por `contact_id`.** Si el usuario se desvincula entre la recepción y un reintento, el mensaje todavía tiene que saber a quién pertenecía. Un `contact_id` con FK se volvería `NULL` y perderíamos el destinatario justo cuando hace falta reprocesar.

- [ ] **Step 2: Aplicarla y verificar idempotencia**

```bash
bun run db:migrate
```

Esperado: `Aplicando 0002_inbound_messages.sql...` y `Listo. 1 migración(es) aplicada(s).`

```bash
bun run db:migrate
```

Esperado: `Sin migraciones pendientes (2 aplicadas).`

- [ ] **Step 3: Verificar el único y el índice parcial**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); const u=await c.query(\"SELECT conname FROM pg_constraint WHERE conrelid='inbound_messages'::regclass AND contype='u'\"); console.log('unicos:', u.rows.length); const i=await c.query(\"SELECT indexname FROM pg_indexes WHERE tablename='inbound_messages' AND indexname LIKE '%pendientes%'\"); console.log('indice parcial:', i.rows.length); await c.end()"
```

Esperado: `unicos: 1` e `indice parcial: 1`.

- [ ] **Step 4: Commit**

```bash
git add migrations/
git commit -m "feat: tabla inbound_messages con dedupe por update_id"
```

---

## Task 2: Firma HMAC

**Files:**
- Create: `src/delivery/signature.ts`
- Test: `src/delivery/signature.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/delivery/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { firmaValida, headerDeFirma } from './signature.js'

const SECRETO = 'secreto'
const CUERPO = '{"a":1}'
const T = 1_785_264_000

// Golden value calculado aparte:
//   createHmac('sha256','secreto').update('1785264000.{"a":1}').digest('hex')
const HMAC_ESPERADO =
  'f57cee0bacf4b9a6811defa9aa5a918b78b9e7b7665a19cd08ce7d78273df5b3'

describe('headerDeFirma', () => {
  it('produce el formato t=<unix>,v1=<hex> con el HMAC correcto', () => {
    expect(headerDeFirma(SECRETO, CUERPO, T)).toBe(`t=${T},v1=${HMAC_ESPERADO}`)
  })

  it('firma el timestamp junto al cuerpo, no el cuerpo solo', () => {
    // Si el timestamp no entrara en la firma, estos dos coincidirían y un
    // atacante podría reusar una firma vieja con un timestamp nuevo.
    expect(headerDeFirma(SECRETO, CUERPO, T)).not.toBe(
      headerDeFirma(SECRETO, CUERPO, T + 1).replace(String(T + 1), String(T)),
    )
  })

  it('cambia por completo si cambia el secreto', () => {
    expect(headerDeFirma('otro', CUERPO, T)).not.toBe(
      headerDeFirma(SECRETO, CUERPO, T),
    )
  })
})

describe('firmaValida', () => {
  it('acepta una firma recién emitida', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, T * 1000)).toBe(true)
  })

  it('acepta dentro de la ventana de 5 minutos', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, (T + 299) * 1000)).toBe(true)
  })

  it('rechaza fuera de la ventana de 5 minutos', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, (T + 301) * 1000)).toBe(false)
  })

  it('rechaza un timestamp del futuro fuera de tolerancia', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, (T - 301) * 1000)).toBe(false)
  })

  it('rechaza si el cuerpo cambió', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, '{"a":2}', header, T * 1000)).toBe(false)
  })

  it('rechaza headers mal formados sin explotar', () => {
    for (const malo of ['', 'chamuyo', 't=abc,v1=xx', `t=${T}`, `v1=abc`]) {
      expect(firmaValida(SECRETO, CUERPO, malo, T * 1000)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/delivery/signature.test.ts
```

Esperado: FAIL — `Cannot find module './signature.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/delivery/signature.ts`:

```ts
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Ventana anti-replay, en segundos, hacia adelante y hacia atrás. */
export const VENTANA_SEGUNDOS = 300

/**
 * El timestamp entra en el material firmado, no solo en el header: si se
 * firmara únicamente el cuerpo, una firma capturada serviría para siempre
 * cambiándole el `t=`.
 */
export function headerDeFirma(
  secreto: string,
  cuerpo: string,
  timestampSegundos: number,
): string {
  const hmac = createHmac('sha256', secreto)
    .update(`${timestampSegundos}.${cuerpo}`)
    .digest('hex')
  return `t=${timestampSegundos},v1=${hmac}`
}

function parsearHeader(header: string): { t: number; v1: string } | null {
  const partes = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const
    }),
  )
  const t = Number(partes.get('t'))
  const v1 = partes.get('v1')
  if (!Number.isFinite(t) || !v1) return null
  return { t, v1 }
}

export function firmaValida(
  secreto: string,
  cuerpo: string,
  header: string,
  ahoraMs: number,
): boolean {
  const parseado = parsearHeader(header)
  if (!parseado) return false

  const deriva = Math.abs(Math.floor(ahoraMs / 1000) - parseado.t)
  if (deriva > VENTANA_SEGUNDOS) return false

  const esperado = createHmac('sha256', secreto)
    .update(`${parseado.t}.${cuerpo}`)
    .digest('hex')

  const a = Buffer.from(esperado, 'utf8')
  const b = Buffer.from(parseado.v1, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

`firmaValida` no la usa comm-tool: la usa **la app receptora**. Vive acá porque es la contraparte exacta de `headerDeFirma` y conviene que estén juntas y probadas contra el mismo golden value. En la fase 4 se va al paquete cliente.

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/delivery/signature.test.ts
```

Esperado: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/
git commit -m "feat: firma HMAC del payload de entrega con ventana anti-replay"
```

---

## Task 3: Backoff

**Files:**
- Create: `src/delivery/backoff.ts`
- Test: `src/delivery/backoff.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/delivery/backoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  esperaInmediata,
  MAX_INTENTOS,
  proximoIntentoMs,
} from './backoff.js'

describe('proximoIntentoMs', () => {
  it('sigue la escalera 10s, 1m, 5m, 30m', () => {
    expect(proximoIntentoMs(1)).toBe(10_000)
    expect(proximoIntentoMs(2)).toBe(60_000)
    expect(proximoIntentoMs(3)).toBe(300_000)
    expect(proximoIntentoMs(4)).toBe(1_800_000)
  })

  it('devuelve null al agotar los 5 intentos', () => {
    expect(proximoIntentoMs(MAX_INTENTOS)).toBeNull()
    expect(proximoIntentoMs(MAX_INTENTOS + 3)).toBeNull()
  })

  it('trata 0 intentos como si viniera el primero', () => {
    expect(proximoIntentoMs(0)).toBe(10_000)
  })
})

describe('esperaInmediata', () => {
  it('el salto de 10 segundos se hace en la misma invocación', () => {
    // Es lo que separa "el bot responde en 10s" de "responde en 15 minutos":
    // en Vercel free una app fría es el caso normal, no una anomalía.
    expect(esperaInmediata(1)).toBe(true)
  })

  it('los saltos de un minuto o más los maneja el ticker', () => {
    expect(esperaInmediata(2)).toBe(false)
    expect(esperaInmediata(3)).toBe(false)
    expect(esperaInmediata(4)).toBe(false)
  })

  it('un intento agotado nunca es inmediato', () => {
    expect(esperaInmediata(MAX_INTENTOS)).toBe(false)
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/delivery/backoff.test.ts
```

Esperado: FAIL — `Cannot find module './backoff.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/delivery/backoff.ts`:

```ts
export const MAX_INTENTOS = 5

/** Espera después del intento N, en milisegundos. */
const ESCALERA = [10_000, 60_000, 300_000, 1_800_000] as const

/** Hasta acá el reintento se hace sin salir de la invocación. */
const UMBRAL_INMEDIATO_MS = 10_000

/**
 * Cuánto falta para el próximo intento, donde `intentosHechos` **incluye el
 * que acaba de fallar**. Devuelve null cuando ya no hay que reintentar.
 *
 * Que el parámetro incluya el intento actual es lo que hace que el total sea
 * 5 sin importar quién llame: el webhook hace dos seguidos y el ticker el
 * resto, pero los dos suman sobre el mismo contador persistido.
 */
export function proximoIntentoMs(intentosHechos: number): number | null {
  if (intentosHechos >= MAX_INTENTOS) return null
  return ESCALERA[Math.max(0, intentosHechos - 1)] ?? null
}

/**
 * Si el próximo intento entra en la misma invocación. Solo el salto de 10
 * segundos: bloquear la función 30 minutos sería absurdo y carísimo.
 */
export function esperaInmediata(intentosHechos: number): boolean {
  const espera = proximoIntentoMs(intentosHechos)
  return espera !== null && espera <= UMBRAL_INMEDIATO_MS
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/delivery/backoff.test.ts
```

Esperado: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/backoff.ts src/delivery/backoff.test.ts
git commit -m "feat: escalera de backoff de la entrega"
```

---

## Task 4: Puerto y repositorio de `inbound_messages`

**Files:**
- Modify: `src/db/ports.ts`, `src/test-support/fake-repos.ts`
- Create: `src/db/repositories/inbound-messages.ts`
- Test: `src/db/repositories/inbound-messages.integration.test.ts`

- [ ] **Step 1: Sumar los tipos y el puerto**

Agregá a `src/db/ports.ts`:

```ts
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped'

export interface InboundMessage {
  id: string
  botId: string
  appId: string
  channel: Channel
  providerUpdateId: string
  externalId: string
  appUserId: string | null
  text: string
  replyToMessageId: string | null
  raw: unknown
  receivedAt: string
  deliveryStatus: DeliveryStatus
  deliveryAttempts: number
  nextAttemptAt: string | null
  deliveredAt: string | null
  lastError: string | null
}

export interface InboundMessagesRepo {
  /**
   * Inserta el crudo. Devuelve null si `(bot_id, provider_update_id)` ya
   * existía: eso es un reintento de Telegram y no hay que reprocesarlo.
   */
  insertIfNew(input: {
    botId: string
    appId: string
    channel: Channel
    providerUpdateId: string
    externalId: string
    appUserId: string | null
    text: string
    replyToMessageId: string | null
    raw: unknown
    deliveryStatus: DeliveryStatus
    nextAttemptAt: Date | null
  }): Promise<InboundMessage | null>

  findById(id: string): Promise<InboundMessage | null>

  /**
   * Toma hasta `limite` pendientes vencidos y les pone un *lease*: corre su
   * `next_attempt_at` hacia adelante para que otro tick no los tome mientras
   * se procesan, y para que vuelvan a estar disponibles si este tick muere a
   * la mitad. **No toca el contador de intentos** — de eso se encargan las
   * marcas de resultado, así el total de 5 sale igual lo llame el webhook o
   * el ticker.
   */
  claimPendientes(ahora: Date, limite: number): Promise<InboundMessage[]>

  marcarEntregado(id: string, ahora: Date): Promise<void>
  /** Incrementa `delivery_attempts`. */
  marcarReintento(id: string, proximoIntento: Date, error: string): Promise<void>
  /** Incrementa `delivery_attempts`. */
  marcarFallido(id: string, error: string): Promise<void>
  /** Vuelve a poner en `pending` un mensaje fallido, con el contador en cero. */
  reencolar(id: string, ahora: Date): Promise<InboundMessage | null>
}
```

Y sumá a `AppsRepo`:

```ts
  findById(id: string): Promise<App | null>
```

- [ ] **Step 2: Escribir el repositorio**

`src/db/repositories/inbound-messages.ts`:

```ts
import type { Sql } from '../client.js'
import type {
  Channel,
  DeliveryStatus,
  InboundMessage,
  InboundMessagesRepo,
} from '../ports.js'

interface Fila {
  id: string
  bot_id: string
  app_id: string
  channel: string
  provider_update_id: string
  external_id: string
  app_user_id: string | null
  text: string
  reply_to_message_id: string | null
  raw: unknown
  received_at: string
  delivery_status: string
  delivery_attempts: number
  next_attempt_at: string | null
  delivered_at: string | null
  last_error: string | null
}

function aMensaje(f: Fila): InboundMessage {
  return {
    id: f.id,
    botId: f.bot_id,
    appId: f.app_id,
    channel: f.channel as Channel,
    providerUpdateId: f.provider_update_id,
    externalId: f.external_id,
    appUserId: f.app_user_id,
    text: f.text,
    replyToMessageId: f.reply_to_message_id,
    raw: f.raw,
    receivedAt: new Date(f.received_at).toISOString(),
    deliveryStatus: f.delivery_status as DeliveryStatus,
    deliveryAttempts: f.delivery_attempts,
    nextAttemptAt: f.next_attempt_at
      ? new Date(f.next_attempt_at).toISOString()
      : null,
    deliveredAt: f.delivered_at ? new Date(f.delivered_at).toISOString() : null,
    lastError: f.last_error,
  }
}

/** Cuánto se reserva un mensaje mientras un tick lo procesa. */
const LEASE_MS = 5 * 60_000

export function createInboundMessagesRepo(sql: Sql): InboundMessagesRepo {
  return {
    async insertIfNew(input) {
      const filas = (await sql`
        INSERT INTO inbound_messages (
          bot_id, app_id, channel, provider_update_id, external_id,
          app_user_id, text, reply_to_message_id, raw, delivery_status,
          next_attempt_at
        ) VALUES (
          ${input.botId}, ${input.appId}, ${input.channel},
          ${input.providerUpdateId}, ${input.externalId}, ${input.appUserId},
          ${input.text}, ${input.replyToMessageId},
          ${JSON.stringify(input.raw)}::jsonb, ${input.deliveryStatus},
          ${input.nextAttemptAt?.toISOString() ?? null}
        )
        ON CONFLICT (bot_id, provider_update_id) DO NOTHING
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      return fila ? aMensaje(fila) : null
    },

    async findById(id) {
      const filas = (await sql`
        SELECT * FROM inbound_messages WHERE id = ${id} LIMIT 1
      `) as Fila[]
      const fila = filas[0]
      return fila ? aMensaje(fila) : null
    },

    async claimPendientes(ahora, limite) {
      // El claim va en UN statement. Con el driver HTTP no hay transacciones,
      // así que la atomicidad tiene que estar en el SQL: SKIP LOCKED hace que
      // dos ticks simultáneos tomen filas distintas.
      //
      // Corre next_attempt_at hacia adelante como lease. Si este tick muere a
      // la mitad, el mensaje vuelve a estar disponible al vencer el lease en
      // vez de quedar trabado para siempre.
      const lease = new Date(ahora.getTime() + LEASE_MS)
      const filas = (await sql`
        UPDATE inbound_messages
        SET next_attempt_at = ${lease.toISOString()}
        WHERE id IN (
          SELECT id FROM inbound_messages
          WHERE delivery_status = 'pending'
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ${ahora.toISOString()}
          ORDER BY next_attempt_at
          LIMIT ${limite}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `) as Fila[]
      return filas.map(aMensaje)
    },

    async marcarEntregado(id, ahora) {
      await sql`
        UPDATE inbound_messages
        SET delivery_status = 'delivered',
            delivered_at = ${ahora.toISOString()},
            next_attempt_at = NULL,
            last_error = NULL
        WHERE id = ${id}
      `
    },

    async marcarReintento(id, proximoIntento, error) {
      await sql`
        UPDATE inbound_messages
        SET delivery_status = 'pending',
            delivery_attempts = delivery_attempts + 1,
            next_attempt_at = ${proximoIntento.toISOString()},
            last_error = ${error}
        WHERE id = ${id}
      `
    },

    async marcarFallido(id, error) {
      await sql`
        UPDATE inbound_messages
        SET delivery_status = 'failed',
            delivery_attempts = delivery_attempts + 1,
            next_attempt_at = NULL,
            last_error = ${error}
        WHERE id = ${id}
      `
    },

    async reencolar(id, ahora) {
      const filas = (await sql`
        UPDATE inbound_messages
        SET delivery_status = 'pending',
            delivery_attempts = 0,
            next_attempt_at = ${ahora.toISOString()},
            last_error = NULL
        WHERE id = ${id} AND delivery_status = 'failed'
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      return fila ? aMensaje(fila) : null
    },
  }
}
```

- [ ] **Step 3: Sumar el doble de test**

Agregá a `src/test-support/fake-repos.ts`:

```ts
export function unMensaje(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    botId: 'bot-1',
    appId: 'app-1',
    channel: 'telegram',
    providerUpdateId: '900001',
    externalId: '12345',
    appUserId: 'user-1',
    text: 'banca 4x10 60',
    replyToMessageId: null,
    raw: { update_id: 900_001 },
    receivedAt: '2026-07-29T12:00:00.000Z',
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    nextAttemptAt: '2026-07-29T12:00:00.000Z',
    deliveredAt: null,
    lastError: null,
    ...over,
  }
}

export function createFakeInboundMessagesRepo(
  inicial: InboundMessage[] = [],
): InboundMessagesRepo {
  const mensajes = [...inicial]
  let siguienteId = inicial.length + 1

  return {
    async insertIfNew(input) {
      const duplicado = mensajes.some(
        (m) =>
          m.botId === input.botId &&
          m.providerUpdateId === input.providerUpdateId,
      )
      if (duplicado) return null

      const creado: InboundMessage = {
        id: `msg-${siguienteId++}`,
        receivedAt: '2026-07-29T12:00:00.000Z',
        deliveryAttempts: 0,
        deliveredAt: null,
        lastError: null,
        ...input,
        nextAttemptAt: input.nextAttemptAt?.toISOString() ?? null,
      }
      mensajes.push(creado)
      return creado
    },

    async findById(id) {
      return mensajes.find((m) => m.id === id) ?? null
    },

    async claimPendientes(ahora, limite) {
      const elegibles = mensajes
        .filter(
          (m) =>
            m.deliveryStatus === 'pending' &&
            m.nextAttemptAt !== null &&
            new Date(m.nextAttemptAt) <= ahora,
        )
        .slice(0, limite)
      // Lease, no incremento: el contador lo mueven las marcas de resultado.
      const tomados = elegibles.map((m) => ({ ...m }))
      for (const m of elegibles) {
        m.nextAttemptAt = new Date(ahora.getTime() + 5 * 60_000).toISOString()
      }
      return tomados
    },

    async marcarEntregado(id, ahora) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.deliveryStatus = 'delivered'
      m.deliveredAt = ahora.toISOString()
      m.nextAttemptAt = null
      m.lastError = null
    },

    async marcarReintento(id, proximoIntento, error) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.deliveryStatus = 'pending'
      m.deliveryAttempts += 1
      m.nextAttemptAt = proximoIntento.toISOString()
      m.lastError = error
    },

    async marcarFallido(id, error) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.deliveryStatus = 'failed'
      m.deliveryAttempts += 1
      m.nextAttemptAt = null
      m.lastError = error
    },

    async reencolar(id, ahora) {
      const m = mensajes.find((x) => x.id === id)
      if (!m || m.deliveryStatus !== 'failed') return null
      m.deliveryStatus = 'pending'
      m.deliveryAttempts = 0
      m.nextAttemptAt = ahora.toISOString()
      m.lastError = null
      return { ...m }
    },
  }
}
```

Sumá `InboundMessage` e `InboundMessagesRepo` al import de tipos del archivo, y en `createFakeAppsRepo` implementá el `findById` nuevo:

```ts
export function createFakeAppsRepo(
  entradas: { hash: string; app: App }[],
): AppsRepo {
  return {
    async findByApiKeyHash(hash) {
      return entradas.find((e) => e.hash === hash)?.app ?? null
    },
    async findById(id) {
      return entradas.find((e) => e.app.id === id)?.app ?? null
    },
  }
}
```

- [ ] **Step 4: Implementar `findById` en el repositorio real**

En `src/db/repositories/apps.ts`, sumá al objeto que devuelve `createAppsRepo`:

```ts
    async findById(id) {
      const filas = (await sql`
        SELECT id, slug, name, delivery_url, schedule_callback_url,
               delivery_secret_env, active
        FROM apps WHERE id = ${id} LIMIT 1
      `) as FilaApp[]
      const fila = filas[0]
      return fila ? aApp(fila) : null
    },
```

- [ ] **Step 5: Escribir el test de integración**

`src/db/repositories/inbound-messages.integration.test.ts`:

```ts
import { Client } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import type { InboundMessagesRepo } from '../ports.js'
import { createInboundMessagesRepo } from './inbound-messages.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_inbound_app'
const SLUG_BOT = '_test_inbound_bot'

correr('inbound_messages contra una base real', () => {
  // Se construye en beforeAll: Vitest evalúa el cuerpo de un describe.skip.
  let repo: InboundMessagesRepo
  let appId = ''
  let botId = ''

  async function limpiar() {
    const c = new Client(DATABASE_URL)
    await c.connect()
    await c.query('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    repo = createInboundMessagesRepo(createSql(DATABASE_URL))
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

    const bot = await c.query<{ id: string }>(
      `INSERT INTO bots (app_id, channel, slug, token_env, webhook_secret_env,
                         unlinked_message)
       VALUES ($1, 'telegram', $2, 'T', 'S', 'x') RETURNING id`,
      [appId, SLUG_BOT],
    )
    const filaBot = bot.rows[0]
    if (!filaBot) throw new Error('no se creó el bot de prueba')
    botId = filaBot.id
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  function base(providerUpdateId: string) {
    return {
      botId,
      appId,
      channel: 'telegram' as const,
      providerUpdateId,
      externalId: '12345',
      appUserId: 'u-1',
      text: 'hola',
      replyToMessageId: null,
      raw: { update_id: Number(providerUpdateId) },
      deliveryStatus: 'pending' as const,
      nextAttemptAt: new Date(),
    }
  }

  it('inserta y devuelve null ante un update_id repetido', async () => {
    const primero = await repo.insertIfNew(base('1001'))
    expect(primero?.text).toBe('hola')

    const repetido = await repo.insertIfNew(base('1001'))
    expect(repetido).toBeNull()
  }, 30_000)

  it('guarda y devuelve el raw como objeto, no como string', async () => {
    const creado = await repo.insertIfNew(base('1002'))
    if (!creado) throw new Error('no se insertó')
    const leido = await repo.findById(creado.id)
    expect(leido?.raw).toEqual({ update_id: 1002 })
  }, 30_000)

  it('dos claims simultáneos no entregan el mismo mensaje dos veces', async () => {
    await repo.insertIfNew(base('1003'))
    const ahora = new Date(Date.now() + 60_000)

    const [a, b] = await Promise.all([
      repo.claimPendientes(ahora, 10),
      repo.claimPendientes(ahora, 10),
    ])

    const ids = [...a, ...b].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  }, 30_000)

  it('el claim pone un lease y NO toca el contador', async () => {
    // Si el claim incrementara, el webhook (que hace 2 intentos por su cuenta)
    // y el ticker contarían distinto y el total dejaría de ser 5.
    const creado = await repo.insertIfNew(base('1004'))
    if (!creado) throw new Error('no se insertó')

    const ahora = new Date(Date.now() + 60_000)
    await repo.claimPendientes(ahora, 50)

    const despues = await repo.findById(creado.id)
    expect(despues?.deliveryAttempts).toBe(0)
    expect(new Date(despues?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(
      ahora.getTime(),
    )
  }, 30_000)

  it('marcar reintento sí incrementa el contador', async () => {
    const creado = await repo.insertIfNew(base('1006'))
    if (!creado) throw new Error('no se insertó')

    await repo.marcarReintento(creado.id, new Date(Date.now() + 60_000), 'x')
    expect((await repo.findById(creado.id))?.deliveryAttempts).toBe(1)
  }, 30_000)

  it('reencola solo lo que está fallido', async () => {
    const creado = await repo.insertIfNew(base('1005'))
    if (!creado) throw new Error('no se insertó')

    expect(await repo.reencolar(creado.id, new Date())).toBeNull()

    await repo.marcarFallido(creado.id, 'se cayó')
    const reencolado = await repo.reencolar(creado.id, new Date())
    expect(reencolado?.deliveryStatus).toBe('pending')
    expect(reencolado?.deliveryAttempts).toBe(0)
  }, 30_000)
})
```

- [ ] **Step 6: Correr los tests**

```bash
bun run test src/db/repositories/inbound-messages.integration.test.ts
```

Esperado con `DATABASE_URL`: PASS, 5 tests.

```bash
DATABASE_URL='' bun run test src/db/repositories/inbound-messages.integration.test.ts
```

Esperado: `skipped`, exit 0. **No usar `env -u`**: bun recarga el `.env` y la verificación no prueba nada.

- [ ] **Step 7: Verificar el resto y commitear**

```bash
bun run typecheck
bun run lint
bun run test
```

```bash
git add src/db/ src/test-support/
git commit -m "feat: repositorio de inbound_messages con claim atómico"
```

---

## Task 5: Cliente de entrega

**Files:**
- Create: `src/delivery/client.ts`
- Test: `src/delivery/client.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/delivery/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDeliveryClient } from './client.js'

function fetchQue(respuesta: () => Promise<Response>) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init })
    return respuesta()
  }
  return { fake, llamadas }
}

const ok = () => Promise.resolve(new Response('', { status: 200 }))

describe('createDeliveryClient', () => {
  it('postea el cuerpo con los headers de firma e idempotencia', async () => {
    const { fake, llamadas } = fetchQue(ok)
    const cliente = createDeliveryClient(fake)

    const res = await cliente.entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{"a":1}',
      firma: 't=1,v1=abc',
      deliveryId: 'del-1',
      timeoutMs: 5000,
    })

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(llamadas[0]?.url).toBe('https://app.test/inbound')

    const headers = new Headers(llamadas[0]?.init?.headers)
    expect(headers.get('X-Comm-Signature')).toBe('t=1,v1=abc')
    expect(headers.get('X-Comm-Delivery-Id')).toBe('del-1')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(llamadas[0]?.init?.body).toBe('{"a":1}')
  })

  it('acepta cualquier 2xx', async () => {
    const { fake } = fetchQue(() =>
      Promise.resolve(new Response('', { status: 204 })),
    )
    const res = await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(true)
  })

  it('trata un 500 como fallo y describe el estado', async () => {
    const { fake } = fetchQue(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    )
    const res = await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/500/)
  })

  it('trata un error de red como fallo, sin propagar la excepción', async () => {
    const { fake } = fetchQue(() => Promise.reject(new Error('ECONNREFUSED')))
    const res = await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ECONNREFUSED/)
  })

  it('pasa una señal de abort para el timeout', async () => {
    const { fake, llamadas } = fetchQue(ok)
    await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(llamadas[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/delivery/client.test.ts
```

Esperado: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/delivery/client.ts`:

```ts
import type { Fetch } from '../channels/telegram/client.js'

export interface EntregaPedido {
  url: string
  cuerpo: string
  firma: string
  deliveryId: string
  timeoutMs: number
}

export interface EntregaResultado {
  ok: boolean
  status: number
  error?: string
}

export interface DeliveryClient {
  entregar(pedido: EntregaPedido): Promise<EntregaResultado>
}

export function createDeliveryClient(
  fetchImpl: Fetch = fetch,
): DeliveryClient {
  return {
    async entregar(pedido) {
      try {
        const res = await fetchImpl(pedido.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Comm-Signature': pedido.firma,
            'X-Comm-Delivery-Id': pedido.deliveryId,
          },
          body: pedido.cuerpo,
          signal: AbortSignal.timeout(pedido.timeoutMs),
        })

        if (res.ok) return { ok: true, status: res.status }
        return {
          ok: false,
          status: res.status,
          error: `la app respondió ${res.status}`,
        }
      } catch (error) {
        // Un error de red no se propaga: es un fallo de entrega más, y quien
        // llama decide si reintentar. Si escapara, el mensaje quedaría sin
        // marcar y el ticker no volvería a tomarlo nunca.
        return { ok: false, status: 0, error: (error as Error).message }
      }
    },
  }
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/delivery/client.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/client.ts src/delivery/client.test.ts
git commit -m "feat: cliente HTTP de entrega con timeout"
```

---

## Task 6: El caso de uso de entrega

El corazón de la fase. **`intentarEntrega` no sabe quién la llamó** — webhook o ticker — y esa indiferencia es lo que hace que el reintento inmediato y el lento compartan una sola implementación probada.

**Files:**
- Create: `src/delivery/deliver.ts`
- Test: `src/delivery/deliver.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/delivery/deliver.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { App, InboundMessagesRepo } from '../db/ports.js'
import {
  createFakeAppsRepo,
  createFakeInboundMessagesRepo,
  unApp,
  unMensaje,
} from '../test-support/fake-repos.js'
import type { DeliveryClient, EntregaResultado } from './client.js'
import { entregarConReintentoInmediato, intentarEntrega } from './deliver.js'

const AHORA = new Date('2026-07-29T12:00:00.000Z')

function armar(opts: {
  respuestas?: EntregaResultado[]
  mensajes?: ReturnType<typeof unMensaje>[]
  app?: App
}) {
  const respuestas = [...(opts.respuestas ?? [{ ok: true, status: 200 }])]
  const pedidos: { url: string; cuerpo: string; firma: string }[] = []

  const telegram: DeliveryClient = {
    async entregar(p) {
      pedidos.push({ url: p.url, cuerpo: p.cuerpo, firma: p.firma })
      return respuestas.shift() ?? { ok: true, status: 200 }
    },
  }

  const app = opts.app ?? unApp()
  const mensajes: InboundMessagesRepo = createFakeInboundMessagesRepo(
    opts.mensajes ?? [unMensaje()],
  )

  const esperas: number[] = []

  return {
    pedidos,
    esperas,
    mensajes,
    deps: {
      inbound: mensajes,
      apps: createFakeAppsRepo([{ hash: 'h', app }]),
      delivery: telegram,
      secrets: () => 'secreto-de-entrega',
      now: () => AHORA,
      sleep: async (ms: number) => {
        esperas.push(ms)
      },
    },
  }
}

describe('intentarEntrega', () => {
  it('firma y postea al delivery_url de la app', async () => {
    const { deps, pedidos } = armar({})
    await intentarEntrega(deps, unMensaje())

    expect(pedidos[0]?.url).toBe('https://gym.example/api/messaging/inbound')
    expect(pedidos[0]?.firma).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('manda userId y nunca el chat_id en el cuerpo', async () => {
    const { deps, pedidos } = armar({})
    await intentarEntrega(deps, unMensaje({ externalId: '987654' }))

    const cuerpo = JSON.parse(pedidos[0]?.cuerpo ?? '{}') as Record<
      string,
      unknown
    >
    expect(cuerpo['userId']).toBe('user-1')
    expect(pedidos[0]?.cuerpo).not.toContain('987654')
  })

  it('marca entregado ante un 2xx', async () => {
    const mensaje = unMensaje()
    const { deps, mensajes } = armar({ mensajes: [mensaje] })

    expect(await intentarEntrega(deps, mensaje)).toBe('delivered')
    expect((await mensajes.findById(mensaje.id))?.deliveryStatus).toBe(
      'delivered',
    )
  })

  it('agenda el próximo intento ante un fallo', async () => {
    const mensaje = unMensaje({ deliveryAttempts: 0 })
    const { deps, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [{ ok: false, status: 500, error: 'la app respondió 500' }],
    })

    expect(await intentarEntrega(deps, mensaje)).toBe('pending')
    const guardado = await mensajes.findById(mensaje.id)
    expect(guardado?.deliveryStatus).toBe('pending')
    expect(guardado?.nextAttemptAt).toBe('2026-07-29T12:00:10.000Z')
    expect(guardado?.deliveryAttempts).toBe(1)
    expect(guardado?.lastError).toMatch(/500/)
  })

  it('escala a un minuto en el segundo fallo', async () => {
    const mensaje = unMensaje({ deliveryAttempts: 1 })
    const { deps, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [{ ok: false, status: 500, error: 'x' }],
    })

    await intentarEntrega(deps, mensaje)
    expect((await mensajes.findById(mensaje.id))?.nextAttemptAt).toBe(
      '2026-07-29T12:01:00.000Z',
    )
  })

  it('se rinde al quinto intento y deja el crudo guardado', async () => {
    const mensaje = unMensaje({ deliveryAttempts: 4 })
    const { deps, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [{ ok: false, status: 500, error: 'sigue caída' }],
    })

    expect(await intentarEntrega(deps, mensaje)).toBe('failed')
    const guardado = await mensajes.findById(mensaje.id)
    expect(guardado?.deliveryStatus).toBe('failed')
    expect(guardado?.raw).toEqual({ update_id: 900_001 })
  })

  it('falla sin reintentar si la app ya no existe', async () => {
    const mensaje = unMensaje({ appId: 'app-borrada' })
    const { deps, mensajes } = armar({ mensajes: [mensaje] })

    expect(await intentarEntrega(deps, mensaje)).toBe('failed')
    expect((await mensajes.findById(mensaje.id))?.lastError).toMatch(/app/i)
  })
})

describe('entregarConReintentoInmediato', () => {
  it('no espera si la primera entrega sale bien', async () => {
    const { deps, esperas, pedidos } = armar({})
    await entregarConReintentoInmediato(deps, unMensaje())

    expect(pedidos).toHaveLength(1)
    expect(esperas).toEqual([])
  })

  it('espera 10 segundos y reintenta una vez si la primera falla', async () => {
    // Es el caso NORMAL en Vercel free: la app está fría y el primer POST
    // llega antes de que termine de arrancar.
    const mensaje = unMensaje()
    const { deps, esperas, pedidos, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [
        { ok: false, status: 0, error: 'timeout' },
        { ok: true, status: 200 },
      ],
    })

    await entregarConReintentoInmediato(deps, mensaje)

    expect(pedidos).toHaveLength(2)
    expect(esperas).toEqual([10_000])
    expect((await mensajes.findById(mensaje.id))?.deliveryStatus).toBe(
      'delivered',
    )
  })

  it('no encadena más de un reintento inmediato', async () => {
    // El salto siguiente es de un minuto: bloquear la invocación tanto sería
    // absurdo y carísimo. De ahí en más es trabajo del ticker.
    const mensaje = unMensaje()
    const { deps, esperas, pedidos } = armar({
      mensajes: [mensaje],
      respuestas: [
        { ok: false, status: 500, error: 'x' },
        { ok: false, status: 500, error: 'x' },
        { ok: true, status: 200 },
      ],
    })

    await entregarConReintentoInmediato(deps, mensaje)

    expect(pedidos).toHaveLength(2)
    expect(esperas).toEqual([10_000])
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/delivery/deliver.test.ts
```

Esperado: FAIL — `Cannot find module './deliver.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/delivery/deliver.ts`:

```ts
import type {
  AppsRepo,
  InboundMessage,
  InboundMessagesRepo,
} from '../db/ports.js'
import type { SecretReader } from '../secrets.js'
import { esperaInmediata, proximoIntentoMs } from './backoff.js'
import type { DeliveryClient } from './client.js'
import { headerDeFirma } from './signature.js'

export const TIMEOUT_ENTREGA_MS = 10_000

export interface DeliverDeps {
  inbound: InboundMessagesRepo
  apps: AppsRepo
  delivery: DeliveryClient
  secrets: SecretReader
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export type ResultadoEntrega = 'delivered' | 'pending' | 'failed'

function cuerpoDeEntrega(mensaje: InboundMessage): string {
  // userId, nunca externalId: la app no conoce el chat_id.
  return JSON.stringify({
    messageId: mensaje.id,
    userId: mensaje.appUserId,
    channel: mensaje.channel,
    text: mensaje.text,
    replyToMessageId: mensaje.replyToMessageId ?? undefined,
    receivedAt: mensaje.receivedAt,
    raw: mensaje.raw,
  })
}

export async function intentarEntrega(
  deps: DeliverDeps,
  mensaje: InboundMessage,
): Promise<ResultadoEntrega> {
  const ahora = deps.now()

  const app = await deps.apps.findById(mensaje.appId)
  if (!app || !app.active) {
    // Sin app no hay a dónde entregar, y reintentar no lo va a cambiar.
    await deps.inbound.marcarFallido(
      mensaje.id,
      `la app ${mensaje.appId} no existe o está inactiva`,
    )
    return 'failed'
  }

  const cuerpo = cuerpoDeEntrega(mensaje)
  const firma = headerDeFirma(
    deps.secrets(app.deliverySecretEnv),
    cuerpo,
    Math.floor(ahora.getTime() / 1000),
  )

  const resultado = await deps.delivery.entregar({
    url: app.deliveryUrl,
    cuerpo,
    firma,
    deliveryId: mensaje.id,
    timeoutMs: TIMEOUT_ENTREGA_MS,
  })

  if (resultado.ok) {
    await deps.inbound.marcarEntregado(mensaje.id, ahora)
    return 'delivered'
  }

  const error = resultado.error ?? `estado ${resultado.status}`
  // +1 porque el intento que acaba de fallar todavía no está contado en la
  // fila: lo contabiliza la marca de resultado, más abajo.
  const espera = proximoIntentoMs(mensaje.deliveryAttempts + 1)

  if (espera === null) {
    await deps.inbound.marcarFallido(mensaje.id, error)
    return 'failed'
  }

  await deps.inbound.marcarReintento(
    mensaje.id,
    new Date(ahora.getTime() + espera),
    error,
  )
  return 'pending'
}

/**
 * Un intento, y si falla y el próximo salto entra en la invocación, uno más.
 * Es lo que llama el webhook después de contestarle 200 a Telegram.
 */
export async function entregarConReintentoInmediato(
  deps: DeliverDeps,
  mensaje: InboundMessage,
): Promise<ResultadoEntrega> {
  const primero = await intentarEntrega(deps, mensaje)
  if (primero !== 'pending') return primero

  const intentosHechos = mensaje.deliveryAttempts + 1
  if (!esperaInmediata(intentosHechos)) return primero

  const espera = proximoIntentoMs(intentosHechos)
  if (espera === null) return primero
  await deps.sleep(espera)

  // Se recarga de la base en vez de mutar el objeto en memoria: el contador
  // que dejó `marcarReintento` es la única fuente de verdad, y así el segundo
  // intento escala igual que si lo hubiera disparado el ticker.
  const recargado = await deps.inbound.findById(mensaje.id)
  if (!recargado || recargado.deliveryStatus !== 'pending') return primero

  return intentarEntrega(deps, recargado)
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/delivery/deliver.test.ts
```

Esperado: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/deliver.ts src/delivery/deliver.test.ts
git commit -m "feat: caso de uso de entrega con reintento inmediato"
```

---

## Task 7: El webhook persiste y entrega

**Files:**
- Modify: `src/routes/telegram-webhook.ts`, `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Escribir los tests nuevos**

Primero reemplazá el helper `armar` de `src/routes/telegram-webhook.test.ts` completo, para que arme también las dependencias de entrega:

```ts
function armar(
  opts: {
    contactos?: Contact[]
    codigos?: LinkCode[]
    entregaFalla?: boolean
  } = {},
) {
  const enviados: { chatId: string; text: string }[] = []
  const entregados: string[] = []
  const contacts = createFakeContactsRepo(opts.contactos ?? [])
  const linkCodes = createFakeLinkCodesRepo(opts.codigos ?? [])
  const inbound = createFakeInboundMessagesRepo([])

  // waitUntil ejecuta al toque en los tests: la entrega tiene que haber
  // terminado cuando el request vuelve, o las aserciones correrían antes.
  const pendientes: Promise<unknown>[] = []

  const server = new Hono()
  server.route(
    '/',
    telegramWebhookRoutes({
      bots: createFakeBotsRepo([unBot()]),
      contacts,
      linkCodes,
      inbound,
      apps: createFakeAppsRepo([{ hash: 'h', app: unApp() }]),
      delivery: {
        async entregar(p) {
          entregados.push(p.deliveryId)
          return opts.entregaFalla
            ? { ok: false, status: 500, error: 'la app respondió 500' }
            : { ok: true, status: 200 }
        },
      },
      secrets: () => SECRETO,
      now: () => AHORA,
      sleep: async () => {},
      waitUntil: (p) => {
        pendientes.push(p)
      },
      telegram: {
        async sendMessage(_token, chatId, text) {
          enviados.push({ chatId, text })
          return { messageId: '1' }
        },
      },
    }),
  )

  return {
    server,
    enviados,
    entregados,
    contacts,
    linkCodes,
    inbound,
    /** Espera a que termine lo que quedó en waitUntil. */
    async drenar() {
      await Promise.all(pendientes)
    },
  }
}
```

`secrets` devuelve `SECRETO` para todo, incluido el de firma de entrega: en estos tests solo importa que la firma se genere, no cuál sea.

Y como `postear` ahora dispara trabajo diferido, sumá el `drenar()` después de cada `postear` en los tests nuevos. El bloque:

```ts
describe('persistencia y entrega', () => {
  it('guarda el crudo antes de intentar entregar', async () => {
    const { server, inbound, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
    })
    await postear(server, update('banca 4x10 60'))
    await drenar()

    const guardado = await inbound.findById('msg-1')
    expect(guardado?.text).toBe('banca 4x10 60')
    expect(guardado?.appUserId).toBe('user-1')
    expect(guardado?.raw).toMatchObject({ update_id: 1 })
  })

  it('descarta un update_id repetido sin entregar dos veces', async () => {
    const { server, entregados, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
    })

    await postear(server, update('hola'))
    await postear(server, update('hola'))
    await drenar()

    expect(entregados).toHaveLength(1)
  })

  it('registra como skipped el mensaje de un chat no vinculado', async () => {
    const { server, inbound, entregados, drenar } = armar()
    await postear(server, update('hola'))
    await drenar()

    const guardado = await inbound.findById('msg-1')
    expect(guardado?.deliveryStatus).toBe('skipped')
    expect(guardado?.appUserId).toBeNull()
    expect(entregados).toHaveLength(0)
  })

  it('no registra ni entrega los comandos de vinculación', async () => {
    // /vincular es de comm-tool, no de la app: entregarlo sería filtrar un
    // comando de identidad al dominio de otro.
    const { server, inbound, entregados, drenar } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF' })],
    })
    await postear(server, update('/vincular ABCDEF'))
    await drenar()

    expect(await inbound.findById('msg-1')).toBeNull()
    expect(entregados).toHaveLength(0)
  })

  it('contesta 200 aunque la entrega falle', async () => {
    // Un 5xx a Telegram provoca reintentos que ya cubre el backoff propio.
    const { server, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      entregaFalla: true,
    })
    const res = await postear(server, update('hola'))
    await drenar()
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/routes/telegram-webhook.test.ts
```

Esperado: FAIL en los cinco casos nuevos.

- [ ] **Step 3: Reescribir la rama de mensajes del webhook**

En `src/routes/telegram-webhook.ts`, extendé `TelegramWebhookDeps`:

```ts
import type { DeliverDeps } from '../delivery/deliver.js'
import { entregarConReintentoInmediato } from '../delivery/deliver.js'
import type { InboundMessagesRepo } from '../db/ports.js'

export interface TelegramWebhookDeps extends DeliverDeps {
  bots: BotsRepo
  contacts: ContactsRepo
  linkCodes: LinkCodesRepo
  telegram: TelegramClient
  secrets: SecretReader
  now: () => Date
  inbound: InboundMessagesRepo
  waitUntil: (promesa: Promise<unknown>) => void
}
```

y reemplazá el bloque que va desde `const contacto = await deps.contacts.findByExternalId(` hasta el `return c.json({ ok: true })` final del handler por:

```ts
    const contacto = await deps.contacts.findByExternalId(
      bot.appId,
      'telegram',
      update.chatId,
    )

    // El crudo se persiste SIEMPRE y antes de cualquier otra cosa: si el
    // parser de la app o la entrega fallan, el dato no se pierde.
    const guardado = await deps.inbound.insertIfNew({
      botId: bot.id,
      appId: bot.appId,
      channel: 'telegram',
      providerUpdateId: update.updateId,
      externalId: update.chatId,
      appUserId: contacto?.appUserId ?? null,
      text: update.text,
      replyToMessageId: update.replyToMessageId ?? null,
      raw: crudo,
      deliveryStatus: contacto ? 'pending' : 'skipped',
      nextAttemptAt: contacto ? deps.now() : null,
    })

    // null = ya lo habíamos visto. Telegram reintenta los webhooks lentos y
    // sin esto cada reintento entregaría el mensaje otra vez.
    if (!guardado) return c.json({ ok: true })

    if (!contacto) {
      await responder(bot.unlinkedMessage)
      return c.json({ ok: true })
    }

    // El 200 sale ya; la entrega ocurre después de la respuesta.
    deps.waitUntil(entregarConReintentoInmediato(deps, guardado))
    return c.json({ ok: true })
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/routes/telegram-webhook.test.ts
```

Esperado: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts
git commit -m "feat: el webhook persiste el crudo y entrega tras el ack"
```

---

## Task 8: Rutas internas

**Files:**
- Create: `src/middleware/internal-auth.ts`, `src/routes/internal.ts`
- Modify: `src/env.ts`
- Test: `src/middleware/internal-auth.test.ts`, `src/routes/internal.test.ts`

- [ ] **Step 1: Sumar `INTERNAL_SECRET` al esquema de entorno**

En `src/env.ts`:

```ts
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'es obligatoria'),
  INTERNAL_SECRET: z.string().min(1, 'es obligatoria'),
})
```

y en `src/env.test.ts`, actualizá los casos existentes para que incluyan `INTERNAL_SECRET: 's'` donde esperan éxito, y agregá:

```ts
  it('falla si falta INTERNAL_SECRET', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://x' })).toThrow(
      /INTERNAL_SECRET/,
    )
  })
```

- [ ] **Step 2: Escribir el test del middleware interno**

`src/middleware/internal-auth.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { internalAuth } from './internal-auth.js'

function armar() {
  const server = new Hono()
  server.use('/interno', internalAuth('el-secreto'))
  server.get('/interno', (c) => c.json({ ok: true }))
  return server
}

describe('internalAuth', () => {
  it('deja pasar con el secreto correcto', async () => {
    const res = await armar().request('/interno', {
      headers: { Authorization: 'Bearer el-secreto' },
    })
    expect(res.status).toBe(200)
  })

  it('rechaza sin header', async () => {
    expect((await armar().request('/interno')).status).toBe(401)
  })

  it('rechaza con el secreto incorrecto', async () => {
    const res = await armar().request('/interno', {
      headers: { Authorization: 'Bearer otro' },
    })
    expect(res.status).toBe(401)
  })

  it('rechaza un secreto de largo distinto sin explotar', async () => {
    const res = await armar().request('/interno', {
      headers: { Authorization: 'Bearer x' },
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 3: Escribir el middleware**

`src/middleware/internal-auth.ts`:

```ts
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export function internalAuth(secreto: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const [esquema, valor] = header.split(' ')

    if (esquema !== 'Bearer' || !valor) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    // Comparación de dos secretos: acá sí hace falta timing-safe, a
    // diferencia de la API key, que se busca por hash en la base.
    const a = Buffer.from(valor, 'utf8')
    const b = Buffer.from(secreto, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    await next()
    return undefined
  }
}
```

- [ ] **Step 4: Escribir el test de las rutas internas**

`src/routes/internal.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { EntregaResultado } from '../delivery/client.js'
import {
  createFakeAppsRepo,
  createFakeInboundMessagesRepo,
  unApp,
  unMensaje,
} from '../test-support/fake-repos.js'
import { internalRoutes } from './internal.js'

const AHORA = new Date('2026-07-29T12:00:00.000Z')

function armar(opts: {
  mensajes?: ReturnType<typeof unMensaje>[]
  respuesta?: EntregaResultado
} = {}) {
  const entregados: string[] = []
  const inbound = createFakeInboundMessagesRepo(opts.mensajes ?? [])

  const server = new Hono()
  server.route(
    '/',
    internalRoutes({
      inbound,
      apps: createFakeAppsRepo([{ hash: 'h', app: unApp() }]),
      delivery: {
        async entregar(p) {
          entregados.push(p.deliveryId)
          return opts.respuesta ?? { ok: true, status: 200 }
        },
      },
      secrets: () => 'secreto',
      now: () => AHORA,
      sleep: async () => {},
    }),
  )

  return { server, inbound, entregados }
}

describe('POST /internal/tick', () => {
  it('entrega los pendientes vencidos', async () => {
    const { server, entregados, inbound } = armar({
      mensajes: [
        unMensaje({ id: 'm1', nextAttemptAt: '2026-07-29T11:00:00.000Z' }),
      ],
    })
    const res = await server.request('/internal/tick', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ procesados: 1, entregados: 1, fallidos: 0 })
    expect(entregados).toEqual(['m1'])
    expect((await inbound.findById('m1'))?.deliveryStatus).toBe('delivered')
  })

  it('no toca los que todavía no vencieron', async () => {
    const { server, entregados } = armar({
      mensajes: [
        unMensaje({ id: 'm1', nextAttemptAt: '2026-07-29T13:00:00.000Z' }),
      ],
    })
    const res = await server.request('/internal/tick', { method: 'POST' })

    expect(await res.json()).toMatchObject({ procesados: 0 })
    expect(entregados).toEqual([])
  })

  it('no toca los entregados ni los salteados', async () => {
    const { server, entregados } = armar({
      mensajes: [
        unMensaje({ id: 'm1', deliveryStatus: 'delivered' }),
        unMensaje({ id: 'm2', deliveryStatus: 'skipped' }),
      ],
    })
    await server.request('/internal/tick', { method: 'POST' })
    expect(entregados).toEqual([])
  })

  it('cuenta los fallidos cuando se agotan los intentos', async () => {
    const { server } = armar({
      mensajes: [
        unMensaje({
          id: 'm1',
          deliveryAttempts: 4,
          nextAttemptAt: '2026-07-29T11:00:00.000Z',
        }),
      ],
      respuesta: { ok: false, status: 500, error: 'caída' },
    })
    const res = await server.request('/internal/tick', { method: 'POST' })
    expect(await res.json()).toMatchObject({ fallidos: 1 })
  })
})

describe('POST /internal/replay/:messageId', () => {
  it('reencola un mensaje fallido', async () => {
    const { server, inbound } = armar({
      mensajes: [unMensaje({ id: 'm1', deliveryStatus: 'failed' })],
    })
    const res = await server.request('/internal/replay/m1', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ requeued: true })
    expect((await inbound.findById('m1'))?.deliveryStatus).toBe('pending')
  })

  it('devuelve 409 si el mensaje no está fallido', async () => {
    const { server } = armar({
      mensajes: [unMensaje({ id: 'm1', deliveryStatus: 'delivered' })],
    })
    const res = await server.request('/internal/replay/m1', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('devuelve 404 si el mensaje no existe', async () => {
    const { server } = armar({})
    const res = await server.request('/internal/replay/no-existe', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 5: Escribir las rutas internas**

`src/routes/internal.ts`:

```ts
import { Hono } from 'hono'
import type { DeliverDeps } from '../delivery/deliver.js'
import { intentarEntrega } from '../delivery/deliver.js'

/** Tope por tick: acota la duración de la invocación. */
const LOTE = 25

export function internalRoutes(deps: DeliverDeps): Hono {
  const rutas = new Hono()

  rutas.post('/internal/tick', async (c) => {
    const pendientes = await deps.inbound.claimPendientes(deps.now(), LOTE)

    let entregados = 0
    let fallidos = 0
    for (const mensaje of pendientes) {
      const resultado = await intentarEntrega(deps, mensaje)
      if (resultado === 'delivered') entregados += 1
      if (resultado === 'failed') fallidos += 1
    }

    return c.json({ procesados: pendientes.length, entregados, fallidos })
  })

  rutas.post('/internal/replay/:messageId', async (c) => {
    const id = c.req.param('messageId')

    const mensaje = await deps.inbound.findById(id)
    if (!mensaje) return c.json({ code: 'not_found' }, 404)

    const reencolado = await deps.inbound.reencolar(id, deps.now())
    if (!reencolado) {
      return c.json(
        { code: 'not_failed', status: mensaje.deliveryStatus },
        409,
      )
    }

    return c.json({ requeued: true })
  })

  return rutas
}
```

`claimPendientes` ya incrementó el contador, así que el mensaje que recibe `intentarEntrega` trae el valor correcto y el backoff avanza sin lógica extra.

- [ ] **Step 6: Correr los tests para verificar que pasan**

```bash
bun run test src/middleware/internal-auth.test.ts src/routes/internal.test.ts src/env.test.ts
```

Esperado: PASS, 4 + 7 + 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/middleware/internal-auth.ts src/middleware/internal-auth.test.ts src/routes/internal.ts src/routes/internal.test.ts src/env.ts src/env.test.ts
git commit -m "feat: /internal/tick y /internal/replay con auth por secreto"
```

---

## Task 9: Cableado

**Files:**
- Modify: `src/create-app.ts`, `src/index.ts`, `src/test-support/fake-deps.ts`
- Modify: `package.json` (dependencia `@vercel/functions`)

- [ ] **Step 1: Instalar `@vercel/functions`**

```bash
bun add @vercel/functions
```

- [ ] **Step 2: Extender `Deps` y montar las rutas**

En `src/create-app.ts`, sumá a `Deps`:

```ts
  inbound: InboundMessagesRepo
  delivery: DeliveryClient
  internalSecret: string
  waitUntil: (promesa: Promise<unknown>) => void
  sleep: (ms: number) => Promise<void>
```

con los imports correspondientes (`InboundMessagesRepo` de `./db/ports.js`, `DeliveryClient` de `./delivery/client.js`), y montá las rutas internas antes del bloque de `/v1`:

```ts
  // Rutas internas: las llama el ticker, no una app. Auth por secreto propio.
  const interno = new Hono()
  interno.use('/internal/*', internalAuth(deps.internalSecret))
  interno.route('/', internalRoutes(deps))
  app.route('/', interno)
```

Igual que con `/v1`, el patrón es `'/internal/*'` y no `'*'`: con `'*'` el middleware corre sobre cualquier ruta no matcheada y una URL inexistente devolvería 401 en vez de 404.

- [ ] **Step 3: Completar las dependencias falsas**

En `src/test-support/fake-deps.ts`, sumá al objeto que devuelve `createFakeDeps`:

```ts
    inbound: createFakeInboundMessagesRepo([]),
    delivery: {
      async entregar() {
        return { ok: true, status: 200 }
      },
    },
    internalSecret: 'secreto-interno',
    waitUntil: () => {},
    sleep: async () => {},
```

- [ ] **Step 4: Armar las dependencias reales**

En `src/index.ts`, sumá los imports y las entradas nuevas:

```ts
import { waitUntil } from '@vercel/functions'
import { createDeliveryClient } from './delivery/client.js'
import { createInboundMessagesRepo } from './db/repositories/inbound-messages.js'
```

```ts
  inbound: createInboundMessagesRepo(sql),
  delivery: createDeliveryClient(),
  internalSecret: env.INTERNAL_SECRET,
  // waitUntil se inyecta en vez de importarse donde se usa: es lo único
  // atado a Vercel en todo el servicio, y autohospedado se reemplaza por
  // `(p) => { void p }` sin tocar una línea de dominio.
  waitUntil: (promesa) => {
    waitUntil(promesa)
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
```

- [ ] **Step 5: Generar y cargar `INTERNAL_SECRET`**

```bash
cd ~/Projects/communication-tool && echo "INTERNAL_SECRET=$(openssl rand -hex 32)" >> .env && echo "listo"
```

```bash
grep '^INTERNAL_SECRET=' .env | cut -d= -f2- | tr -d '\n' | bun --bun x vercel env add INTERNAL_SECRET production
```

- [ ] **Step 6: Verificar todo junto**

```bash
bun run typecheck
bun run lint
bun run test
```

```bash
DATABASE_URL='' bun run test
```

Esperado: los primeros tres en verde, y el último con los archivos de integración salteados.

- [ ] **Step 7: Verificar el entrypoint del build**

```bash
bun --bun x vercel build --yes >/dev/null 2>&1 && grep handler .vercel/output/functions/index.func/.vc-config.json
```

Esperado: `"handler": "src/index.js"`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: cableado de la entrega y las rutas internas"
```

---

## Task 10: Verificación local de punta a punta

Antes de tocar producción, probamos el circuito completo contra un receptor local.

**Files:**
- Create: `scripts/receptor-de-prueba.ts`

- [ ] **Step 1: Escribir un receptor que valide la firma**

`scripts/receptor-de-prueba.ts`:

```ts
import { firmaValida } from '../src/delivery/signature.js'

const SECRETO = process.env.DELIVERY_SECRET_GYM ?? ''
if (!SECRETO) throw new Error('falta DELIVERY_SECRET_GYM')

const vistos = new Set<string>()

export default {
  port: 4321,
  async fetch(req: Request): Promise<Response> {
    const cuerpo = await req.text()
    const firma = req.headers.get('X-Comm-Signature') ?? ''
    const deliveryId = req.headers.get('X-Comm-Delivery-Id') ?? ''

    if (!firmaValida(SECRETO, cuerpo, firma, Date.now())) {
      console.log('FIRMA INVÁLIDA — rechazado')
      return new Response('firma inválida', { status: 401 })
    }

    if (vistos.has(deliveryId)) {
      console.log(`duplicado ${deliveryId} — deduplicado, no se procesa`)
      return new Response('ok', { status: 200 })
    }
    vistos.add(deliveryId)

    console.log(`ENTREGA OK ${deliveryId}:`, cuerpo)
    return new Response('ok', { status: 200 })
  },
}
```

Es también el ejemplo mínimo de lo que GymTracker tiene que implementar en su fase 3.

- [ ] **Step 2: Levantar el receptor**

```bash
bun run scripts/receptor-de-prueba.ts
```

Dejalo corriendo en una terminal aparte.

- [ ] **Step 3: Apuntar la app de prueba al receptor**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); await c.query(\"UPDATE apps SET delivery_url='http://localhost:4321/inbound' WHERE slug='gym-tracker'\"); console.log('delivery_url apuntando al receptor local'); await c.end()"
```

- [ ] **Step 4: Levantar el servicio y vincular**

```bash
PORT=3987 bun run dev
```

En otra terminal, emitir un código y vincular con `curl` simulando el webhook de Telegram:

```bash
curl -s -X POST localhost:3987/v1/link-codes \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' -d '{"userId":"local-1"}'
```

```bash
curl -s -X POST localhost:3987/webhooks/telegram/gym \
  -H "X-Telegram-Bot-Api-Secret-Token: $(grep '^TELEGRAM_WEBHOOK_SECRET_GYM=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"update_id":5001,"message":{"message_id":1,"chat":{"id":"99999","type":"private"},"date":1785264000,"text":"/vincular <EL_CODIGO>"}}'
```

- [ ] **Step 5: Mandar un mensaje y ver la entrega**

```bash
curl -s -X POST localhost:3987/webhooks/telegram/gym \
  -H "X-Telegram-Bot-Api-Secret-Token: $(grep '^TELEGRAM_WEBHOOK_SECRET_GYM=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"update_id":5002,"message":{"message_id":2,"chat":{"id":"99999","type":"private"},"date":1785264000,"text":"banca 4x10 60"}}'
```

Esperado en la terminal del receptor: `ENTREGA OK <uuid>: {"messageId":...,"userId":"local-1","text":"banca 4x10 60",...}`.

**Verificá que el `chat_id` no aparezca en los campos estructurados**: tiene que venir `userId`, y no un `externalId` ni un `chatId`.

Ojo con la formulación fácil de "que el cuerpo no contenga `99999`": **no se cumple, y está bien que no se cumpla**. El spec manda entregar el `raw` completo (§El contrato y §Qué no es), y el update de Telegram trae `chat.id` adentro. La invariante «la app nunca ve un `chat_id`» es sobre la identidad *resuelta* —la app correlaciona por `userId` y no tiene por qué mirar el `raw`—, no sobre scrubear el payload del proveedor.

- [ ] **Step 6: Probar el dedupe de Telegram**

Repetí el comando del paso 5 **sin cambiar el `update_id`**. El receptor no tiene que imprimir una segunda entrega: el mensaje se descarta antes.

- [ ] **Step 7: Probar el reintento**

Cortá el receptor (Ctrl+C) y mandá un mensaje con `update_id` nuevo. Después de unos 10 segundos vas a ver dos intentos fallidos en el log del servicio. Volvé a levantar el receptor y dispará el tick a mano:

```bash
curl -s -X POST localhost:3987/internal/tick \
  -H "Authorization: Bearer $(grep '^INTERNAL_SECRET=' .env | cut -d= -f2-)"
```

Esperado: `{"procesados":1,"entregados":1,"fallidos":0}` y la entrega en el receptor.

- [ ] **Step 8: Restaurar el `delivery_url`**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); await c.query(\"UPDATE apps SET delivery_url='https://gym-tracker.vercel.app/api/messaging/inbound' WHERE slug='gym-tracker'\"); await c.query(\"DELETE FROM contacts WHERE app_user_id='local-1'\"); console.log('restaurado'); await c.end()"
```

- [ ] **Step 9: Commit**

```bash
git add scripts/receptor-de-prueba.ts
git commit -m "chore: receptor de prueba que valida la firma de entrega"
```

---

## Task 11: El ticker externo

Requiere al usuario: hay que dar de alta un disparador afuera de Vercel.

- [ ] **Step 1: Elegir y configurar el ticker**

Vercel Hobby no sirve: sus cron jobs corren **una vez por día**. Dos opciones gratis, ambas configuración y no código:

**cron-job.org** — crear una cuenta, agregar un job cada 15 minutos:
- URL: `https://communication-tool-beta.vercel.app/internal/tick`
- Método: `POST`
- Header: `Authorization: Bearer <INTERNAL_SECRET>`

**`pg_cron` + `pg_net` en un proyecto Supabase existente** — si preferís no sumar un tercero.

**Frecuencia: cada 15 minutos.** Neon se suspende a los 5 minutos de inactividad y da 100 horas de cómputo al mes; un ticker cada 5 minutos no la dejaría dormir nunca. Conviene medir el consumo real la primera semana en el dashboard de Neon y ajustar.

- [ ] **Step 2: Verificar la autenticación del tick en producción**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://communication-tool-beta.vercel.app/internal/tick
```

Esperado: `401`.

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/internal/tick \
  -H "Authorization: Bearer $(grep '^INTERNAL_SECRET=' .env | cut -d= -f2-)"
```

Esperado: `{"procesados":0,"entregados":0,"fallidos":0}`.

- [ ] **Step 3: Verificar que el ticker externo dispara**

Esperá un ciclo y confirmá en el panel del ticker que la última corrida devolvió 200.

- [ ] **Step 4: Confirmar que no quedan mensajes trabados**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); const r=await c.query('SELECT delivery_status, count(*)::text FROM inbound_messages GROUP BY 1 ORDER BY 1'); console.table(r.rows); await c.end()"
```

---

## Verificación de la fase

- [ ] `bun run lint && bun run typecheck && bun run test` en verde.
- [ ] `DATABASE_URL='' bun run test` deja los archivos de integración salteados y sale con 0.
- [ ] CI en verde en GitHub.
- [ ] `bun run db:migrate` reporta `Sin migraciones pendientes (2 aplicadas).`
- [ ] El receptor local recibe la entrega con firma válida, y el `chat_id` **no aparece en los campos estructurados** — hay `userId`, no hay `externalId` ni `chatId`. Dentro de `raw` sí viaja, por contrato del spec.
- [ ] Un `update_id` repetido no produce una segunda entrega.
- [ ] Cortar el receptor y volver a levantarlo: el `/internal/tick` recupera el mensaje pendiente.
- [ ] `POST /internal/tick` sin `Authorization` devuelve **401** en producción.
- [ ] El ticker externo corre cada 15 minutos y devuelve 200.

El que cierra la fase es el de cortar el receptor: prueba que **un mensaje no se pierde aunque la app esté caída**, que es la razón entera por la que existe esta fase.
