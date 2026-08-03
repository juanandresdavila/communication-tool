# communication-tool — Fase 5: Scheduler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una app pueda registrar un aviso recurrente con expresión cron y zona horaria, y que comm-tool la despierte a la hora exacta para que ella arme el mensaje.

**Architecture:** El mismo ticker que ya dispara los reintentos de entrega pasa a mirar también los programados vencidos. Al vencer uno, comm-tool **no compone el mensaje**: postea al `schedule_callback_url` de la app, firmado con el mismo HMAC de la entrega, y la app decide qué decir y llama a `/v1/messages`. El cálculo de la próxima ejecución con zona horaria se delega a `croner`.

**Tech Stack:** Hono, Bun, TypeScript, Zod, `croner`, `@neondatabase/serverless`, Vitest, Neon.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## Alcance

Del spec, §Fases: «Scheduler — `schedules`, callbacks, migración del check-in nocturno».

**Entra:** la tabla `schedules`, `POST /v1/schedules` y `DELETE /v1/schedules/:name`, el cálculo de la próxima ejecución con zona horaria, y el disparo de callbacks firmados desde `/internal/tick`.

**El check-in nocturno no se migra, porque no existe todavía.** GymTracker no
tiene ni `vercel.json` ni ruta de cron: su check-in es parte de **su** fase 4,
que no está hecha. Su propia sesión anotó que construirlo sobre Vercel Cron
significaba migrarlo dos veces —«lo que construyamos ahora tiene fecha de
vencimiento conocida»—. Como comm-tool llegó primero, esa segunda migración
se puede evitar entera: **GymTracker construye el check-in directo sobre el
scheduler.** Este plan entrega el lado de comm-tool y el contrato que su fase 4
va a consumir.

**No entra:** modo `static` de texto fijo. El spec lo descarta como YAGNI —
prácticamente todo programado real necesita datos de dominio, y el modo
callback ya cubre ese caso.

## La decisión de fondo: `croner` en vez de hacerlo a mano

El spec pide TDD sobre «la próxima ejecución de un cron con zona horaria»
(§Testing). Implementarlo a mano es donde viven los bugs que aparecen una vez
al año: horas inexistentes y horas ambiguas en los saltos de horario de verano.
Argentina no tiene DST desde 2009, así que una implementación casera parecería
correcta durante años y rompería el día que Study Master sume un usuario en otra
zona.

`croner@10` no tiene dependencias, trae sus tipos y maneja DST. `cron-parser`
arrastra `luxon`. Los tests siguen siendo nuestros: se prueba **nuestro**
`proximaEjecucion`, incluida su conducta en un salto de DST, no la librería.

## Cómo se comporta un programado que falla

El spec da `last_status` y ninguna columna de reintentos, así que el
comportamiento hay que elegirlo. Con un ticker cada 15 minutos y un check-in a
las 22:00, un fallo transitorio —la app fría, que en Vercel free es el caso
normal— perdería el aviso del día entero.

**La regla: no se avanza `next_run_at` cuando el callback falla, pero solo se
dispara dentro de una ventana de gracia de una hora.** El tick siguiente
reintenta, y a la cuarta el programado queda fuera de la ventana, se marca
`missed` y salta a la próxima ocurrencia. Da ~4 reintentos sin inventar una
columna y sin reintentar para siempre contra una app rota.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/0004_schedules.sql` | La tabla y su índice de vencidos |
| `src/schedules/cron.ts` | `proximaEjecucion(cron, tz, desde)`. **Puro** |
| `src/schedules/fire.ts` | Disparar un programado vencido y marcar el resultado |
| `src/db/repositories/schedules.ts` | `SchedulesRepo` sobre Neon |
| `src/routes/schedules.ts` | `POST /v1/schedules`, `DELETE /v1/schedules/:name` |
| `src/db/ports.ts` | **Modificar**: `Schedule`, `SchedulesRepo` |
| `src/routes/internal.ts` | **Modificar**: el tick también dispara programados |
| `src/create-app.ts`, `src/index.ts` | **Modificar**: cablear |

---

## Task 1: Migración de `schedules`

**Files:**
- Create: `migrations/0004_schedules.sql`

- [ ] **Step 1: Escribir la migración**

```sql
CREATE TABLE schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  app_user_id  text        NOT NULL,
  name         text        NOT NULL,
  cron         text        NOT NULL,
  timezone     text        NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_status  text        CHECK (last_status IN ('fired', 'failed', 'missed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, app_user_id, name)
);

-- Índice parcial, igual que el de entrantes: el ticker solo pregunta por
-- activos vencidos, y en un historial largo la mayoría no lo está.
CREATE INDEX schedules_vencidos_idx
  ON schedules (next_run_at)
  WHERE active;
```

`next_run_at` es nullable a propósito: un programado desactivado no tiene
próxima ejecución, y dejarlo en `NULL` lo saca del índice parcial sin borrarlo.

- [ ] **Step 2: Aplicar y verificar**

```bash
bun run db:migrate
```

Esperado: `Aplicando 0004_schedules.sql...` y después `Sin migraciones pendientes (4 aplicadas).`

- [ ] **Step 3: Commit**

```bash
git add migrations/ && git commit -m "feat: tabla schedules"
```

---

## Task 2: La próxima ejecución

El módulo frágil de la fase. **Puro**, sin base ni red.

**Files:**
- Create: `src/schedules/cron.ts`
- Test: `src/schedules/cron.test.ts`

- [ ] **Step 1: Instalar croner**

```bash
bun add croner
```

- [ ] **Step 2: Escribir los tests que fallan**

`src/schedules/cron.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cronValido, proximaEjecucion, zonaValida } from './cron.js'

const BA = 'America/Argentina/Buenos_Aires'

describe('proximaEjecucion', () => {
  it('resuelve las 22:00 de Buenos Aires en UTC', () => {
    // Buenos Aires es UTC-3 todo el año: las 22:00 locales son las 01:00 UTC
    // del día siguiente. Si esto diera 22:00 UTC, el check-in llegaría a las
    // 19:00 hora del usuario.
    const desde = new Date('2026-08-02T12:00:00.000Z')
    expect(proximaEjecucion('0 22 * * *', BA, desde)?.toISOString()).toBe(
      '2026-08-03T01:00:00.000Z',
    )
  })

  it('devuelve la ocurrencia siguiente, nunca la que ya pasó', () => {
    const desde = new Date('2026-08-03T02:00:00.000Z')
    const proxima = proximaEjecucion('0 22 * * *', BA, desde)
    expect(proxima?.getTime()).toBeGreaterThan(desde.getTime())
    expect(proxima?.toISOString()).toBe('2026-08-04T01:00:00.000Z')
  })

  it('respeta la zona horaria: la misma expresión da distinto en Madrid', () => {
    const desde = new Date('2026-08-02T12:00:00.000Z')
    const ba = proximaEjecucion('0 22 * * *', BA, desde)
    const madrid = proximaEjecucion('0 22 * * *', 'Europe/Madrid', desde)
    expect(ba?.toISOString()).not.toBe(madrid?.toISOString())
  })

  it('cruza un salto de horario de verano sin devolver una hora inexistente', () => {
    // Madrid adelanta el 29/3/2026 a las 02:00 -> 03:00. Un programado a las
    // 02:30 ese día no existe. Lo que NO puede pasar es devolver null o una
    // fecha anterior a `desde`: eso trabaría el programado para siempre.
    const desde = new Date('2026-03-28T12:00:00.000Z')
    const proxima = proximaEjecucion('30 2 * * *', 'Europe/Madrid', desde)
    expect(proxima).not.toBeNull()
    expect(proxima?.getTime()).toBeGreaterThan(desde.getTime())
  })

  it('devuelve null ante una expresión inválida en vez de explotar', () => {
    expect(proximaEjecucion('esto no es cron', BA, new Date())).toBeNull()
  })

  it('devuelve null ante una zona inválida en vez de explotar', () => {
    expect(proximaEjecucion('0 22 * * *', 'Marte/Olympus', new Date())).toBeNull()
  })
})

describe('cronValido', () => {
  it('acepta expresiones de cinco campos', () => {
    expect(cronValido('0 22 * * *')).toBe(true)
    expect(cronValido('*/15 * * * *')).toBe(true)
  })

  it('rechaza cualquier cosa', () => {
    expect(cronValido('')).toBe(false)
    expect(cronValido('esto no es cron')).toBe(false)
    expect(cronValido('99 99 * * *')).toBe(false)
  })
})

describe('zonaValida', () => {
  it('acepta zonas IANA', () => {
    expect(zonaValida(BA)).toBe(true)
    expect(zonaValida('UTC')).toBe(true)
  })

  it('rechaza lo que no es una zona', () => {
    expect(zonaValida('Marte/Olympus')).toBe(false)
    expect(zonaValida('')).toBe(false)
  })
})
```

- [ ] **Step 3: Correr los tests para verificar que fallan**

```bash
DATABASE_URL='' bun run test src/schedules/cron.test.ts
```

Esperado: FAIL — `Cannot find module './cron.js'`.

- [ ] **Step 4: Escribir la implementación**

`src/schedules/cron.ts`:

```ts
import { Cron } from 'croner'

/**
 * La próxima ejecución de una expresión cron en una zona horaria, o null si
 * la expresión o la zona no sirven.
 *
 * Se delega en croner en vez de calcularlo a mano: los saltos de horario de
 * verano producen horas inexistentes y horas ambiguas, y una implementación
 * casera parece correcta durante años en una zona sin DST como Argentina.
 */
export function proximaEjecucion(
  expresion: string,
  zona: string,
  desde: Date,
): Date | null {
  if (!zonaValida(zona)) return null
  try {
    const proxima = new Cron(expresion, { timezone: zona }).nextRun(desde)
    return proxima ?? null
  } catch {
    // croner tira ante una expresión inválida. Devolver null deja que quien
    // llama decida: la ruta contesta 400 y el ticker desactiva el programado.
    return null
  }
}

export function cronValido(expresion: string): boolean {
  if (expresion.trim() === '') return false
  try {
    // Se pide la próxima ejecución además de construirlo: croner acepta
    // algunas expresiones que después no producen ninguna corrida.
    return new Cron(expresion).nextRun() !== null
  } catch {
    return false
  }
}

export function zonaValida(zona: string): boolean {
  if (zona.trim() === '') return false
  try {
    // La forma estándar de validar una zona IANA sin tabla propia: Intl tira
    // RangeError si no la conoce.
    new Intl.DateTimeFormat('en-US', { timeZone: zona })
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

```bash
DATABASE_URL='' bun run test src/schedules/cron.test.ts
```

Esperado: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/schedules/ package.json bun.lock && git commit -m "feat: proxima ejecucion de un cron con zona horaria"
```

---

## Task 3: Puerto y repositorio de `schedules`

**Files:**
- Modify: `src/db/ports.ts`, `src/test-support/fake-repos.ts`
- Create: `src/db/repositories/schedules.ts`

- [ ] **Step 1: Sumar los tipos y el puerto**

Agregá a `src/db/ports.ts`:

```ts
export type ScheduleStatus = 'fired' | 'failed' | 'missed'

export interface Schedule {
  id: string
  appId: string
  appUserId: string
  name: string
  cron: string
  timezone: string
  active: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: ScheduleStatus | null
}

export interface SchedulesRepo {
  /** Alta o actualización por `(app_id, app_user_id, name)`. */
  upsert(input: {
    appId: string
    appUserId: string
    name: string
    cron: string
    timezone: string
    nextRunAt: Date
  }): Promise<Schedule>

  /** Devuelve false si no había nada que dar de baja. */
  deleteByName(
    appId: string,
    appUserId: string,
    name: string,
  ): Promise<boolean>

  /**
   * Toma hasta `limite` programados activos vencidos. Igual que el claim de
   * entrantes, corre `next_run_at` como lease para que dos ticks simultáneos
   * no disparen el mismo aviso dos veces.
   */
  claimVencidos(ahora: Date, limite: number): Promise<Schedule[]>

  marcarDisparado(id: string, ahora: Date, proxima: Date): Promise<void>
  /** Deja `next_run_at` quieto: el tick siguiente reintenta. */
  marcarFallido(id: string, ahora: Date): Promise<void>
  /** Se pasó la ventana de gracia: salta a la próxima ocurrencia. */
  marcarPerdido(id: string, ahora: Date, proxima: Date): Promise<void>
}
```

- [ ] **Step 2: Escribir el repositorio**

`src/db/repositories/schedules.ts`:

```ts
import type { Sql } from '../client.js'
import type { Schedule, ScheduleStatus, SchedulesRepo } from '../ports.js'

interface Fila {
  id: string
  app_id: string
  app_user_id: string
  name: string
  cron: string
  timezone: string
  active: boolean
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
}

function aSchedule(f: Fila): Schedule {
  return {
    id: f.id,
    appId: f.app_id,
    appUserId: f.app_user_id,
    name: f.name,
    cron: f.cron,
    timezone: f.timezone,
    active: f.active,
    nextRunAt: f.next_run_at ? new Date(f.next_run_at).toISOString() : null,
    lastRunAt: f.last_run_at ? new Date(f.last_run_at).toISOString() : null,
    lastStatus: (f.last_status as ScheduleStatus | null) ?? null,
  }
}

/** Cuánto se reserva un programado mientras un tick lo dispara. */
const LEASE_MS = 5 * 60_000

export function createSchedulesRepo(sql: Sql): SchedulesRepo {
  return {
    async upsert(input) {
      const filas = (await sql`
        INSERT INTO schedules (
          app_id, app_user_id, name, cron, timezone, next_run_at, active
        ) VALUES (
          ${input.appId}, ${input.appUserId}, ${input.name}, ${input.cron},
          ${input.timezone}, ${input.nextRunAt.toISOString()}, true
        )
        ON CONFLICT (app_id, app_user_id, name) DO UPDATE
        SET cron = EXCLUDED.cron,
            timezone = EXCLUDED.timezone,
            next_run_at = EXCLUDED.next_run_at,
            active = true
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      if (!fila) throw new Error('el upsert de schedules no devolvió fila')
      return aSchedule(fila)
    },

    async deleteByName(appId, appUserId, name) {
      const filas = (await sql`
        DELETE FROM schedules
        WHERE app_id = ${appId} AND app_user_id = ${appUserId}
          AND name = ${name}
        RETURNING id
      `) as { id: string }[]
      return filas.length > 0
    },

    async claimVencidos(ahora, limite) {
      const lease = new Date(ahora.getTime() + LEASE_MS)
      const filas = (await sql`
        UPDATE schedules
        SET next_run_at = ${lease.toISOString()}
        WHERE id IN (
          SELECT id FROM schedules
          WHERE active = true
            AND next_run_at IS NOT NULL
            AND next_run_at <= ${ahora.toISOString()}
          ORDER BY next_run_at
          LIMIT ${limite}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `) as Fila[]
      // Se devuelve el next_run_at ORIGINAL, no el lease: `fire` necesita
      // saber para cuándo estaba agendado para calcular la ventana de gracia.
      return filas.map(aSchedule)
    },

    async marcarDisparado(id, ahora, proxima) {
      await sql`
        UPDATE schedules
        SET last_run_at = ${ahora.toISOString()},
            last_status = 'fired',
            next_run_at = ${proxima.toISOString()}
        WHERE id = ${id}
      `
    },

    async marcarFallido(id, ahora) {
      await sql`
        UPDATE schedules
        SET last_run_at = ${ahora.toISOString()}, last_status = 'failed'
        WHERE id = ${id}
      `
    },

    async marcarPerdido(id, ahora, proxima) {
      await sql`
        UPDATE schedules
        SET last_run_at = ${ahora.toISOString()},
            last_status = 'missed',
            next_run_at = ${proxima.toISOString()}
        WHERE id = ${id}
      `
    },
  }
}
```

**Ojo con `claimVencidos`:** el `RETURNING *` devuelve la fila **después** del
`UPDATE`, así que `next_run_at` ya viene con el lease y no con el horario
original. Eso rompería el cálculo de la ventana de gracia. La Task 4 lo
resuelve capturando el valor viejo en el propio statement — ver ahí.

- [ ] **Step 3: Commit**

```bash
git add src/db/ && git commit -m "feat: repositorio de schedules"
```

---

## Task 4: Corregir el claim para conservar el horario agendado

El problema que anota la Task 2 no es teórico: sin el horario original, un
programado nunca sale de la ventana de gracia y se reintenta para siempre.

**Files:**
- Modify: `src/db/repositories/schedules.ts`, `src/db/ports.ts`

- [ ] **Step 1: Devolver el horario viejo junto a la fila**

En `src/db/ports.ts`, cambiá la firma:

```ts
  /**
   * Devuelve cada programado junto al horario para el que **estaba** agendado,
   * porque el claim le pisa `next_run_at` con el lease y `fire` necesita el
   * original para decidir si todavía está dentro de la ventana de gracia.
   */
  claimVencidos(
    ahora: Date,
    limite: number,
  ): Promise<{ schedule: Schedule; agendadoPara: string }[]>
```

En `src/db/repositories/schedules.ts`, reemplazá `claimVencidos`:

```ts
    async claimVencidos(ahora, limite) {
      const lease = new Date(ahora.getTime() + LEASE_MS)
      // El CTE captura next_run_at ANTES del update. Sin esto el RETURNING
      // devuelve el lease y se pierde para cuándo estaba agendado.
      const filas = (await sql`
        WITH elegidos AS (
          SELECT id, next_run_at AS agendado_para
          FROM schedules
          WHERE active = true
            AND next_run_at IS NOT NULL
            AND next_run_at <= ${ahora.toISOString()}
          ORDER BY next_run_at
          LIMIT ${limite}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE schedules s
        SET next_run_at = ${lease.toISOString()}
        FROM elegidos e
        WHERE s.id = e.id
        RETURNING s.*, e.agendado_para
      `) as (Fila & { agendado_para: string })[]

      return filas.map((f) => ({
        schedule: aSchedule(f),
        agendadoPara: new Date(f.agendado_para).toISOString(),
      }))
    },
```

- [ ] **Step 2: Commit**

```bash
git add src/db/ && git commit -m "fix: el claim de schedules conserva el horario agendado"
```

---

## Task 5: Disparar un programado

**Files:**
- Create: `src/schedules/fire.ts`
- Test: `src/schedules/fire.test.ts`

- [ ] **Step 1: Escribir la implementación**

`src/schedules/fire.ts`:

```ts
import { headerDeFirma } from '../client/signature.js'
import type { AppsRepo, Schedule, SchedulesRepo } from '../db/ports.js'
import type { DeliveryClient } from '../delivery/client.js'
import type { SecretReader } from '../secrets.js'
import { proximaEjecucion } from './cron.js'

export const TIMEOUT_CALLBACK_MS = 10_000

/**
 * Cuánto se tolera disparar tarde. Con un ticker cada 15 minutos da ~4
 * reintentos y después el aviso se da por perdido, en vez de reintentar para
 * siempre contra una app rota.
 */
export const GRACIA_MS = 60 * 60_000

export interface FireDeps {
  schedules: SchedulesRepo
  apps: AppsRepo
  delivery: DeliveryClient
  secrets: SecretReader
  now: () => Date
}

export type ResultadoDisparo = 'fired' | 'failed' | 'missed' | 'skipped'

export async function dispararProgramado(
  deps: FireDeps,
  schedule: Schedule,
  agendadoPara: string,
): Promise<ResultadoDisparo> {
  const ahora = deps.now()

  const proxima = proximaEjecucion(schedule.cron, schedule.timezone, ahora)
  if (!proxima) {
    // La expresión dejó de ser válida. Marcarlo perdido sin próxima ejecución
    // lo saca del índice en vez de trabar el tick para siempre.
    await deps.schedules.marcarFallido(schedule.id, ahora)
    return 'failed'
  }

  // Fuera de la ventana de gracia: el aviso de esa hora ya no sirve. Se salta
  // a la próxima ocurrencia en vez de mandarlo tardísimo.
  if (ahora.getTime() - new Date(agendadoPara).getTime() > GRACIA_MS) {
    await deps.schedules.marcarPerdido(schedule.id, ahora, proxima)
    return 'missed'
  }

  const app = await deps.apps.findById(schedule.appId)
  if (!app || !app.active || !app.scheduleCallbackUrl) {
    await deps.schedules.marcarFallido(schedule.id, ahora)
    return 'skipped'
  }

  // comm-tool NO compone el mensaje: despierta a la app y ella decide.
  const cuerpo = JSON.stringify({
    scheduleId: schedule.id,
    name: schedule.name,
    userId: schedule.appUserId,
    firedAt: ahora.toISOString(),
  })

  const resultado = await deps.delivery.entregar({
    url: app.scheduleCallbackUrl,
    cuerpo,
    firma: headerDeFirma(
      deps.secrets(app.deliverySecretEnv),
      cuerpo,
      Math.floor(ahora.getTime() / 1000),
    ),
    deliveryId: `${schedule.id}:${agendadoPara}`,
    timeoutMs: TIMEOUT_CALLBACK_MS,
  })

  if (!resultado.ok) {
    // No se toca next_run_at: el tick siguiente reintenta, hasta que se pase
    // la ventana de gracia.
    await deps.schedules.marcarFallido(schedule.id, ahora)
    return 'failed'
  }

  await deps.schedules.marcarDisparado(schedule.id, ahora, proxima)
  return 'fired'
}
```

**El `deliveryId` es `<scheduleId>:<agendadoPara>`** y no un uuid nuevo: si un
reintento del mismo disparo llega dos veces, la app lo deduplica por ese id.
Un uuid distinto por intento haría que el check-in se mandara dos veces.

- [ ] **Step 2: Escribir los tests**

`src/schedules/fire.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Schedule } from '../db/ports.js'
import type { EntregaResultado } from '../delivery/client.js'
import { createFakeAppsRepo, unApp } from '../test-support/fake-repos.js'
import { dispararProgramado, GRACIA_MS } from './fire.js'

const AHORA = new Date('2026-08-03T01:00:30.000Z')
const AGENDADO = '2026-08-03T01:00:00.000Z'

function unSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    appId: 'app-1',
    appUserId: 'user-1',
    name: 'checkin-nocturno',
    cron: '0 22 * * *',
    timezone: 'America/Argentina/Buenos_Aires',
    active: true,
    nextRunAt: AGENDADO,
    lastRunAt: null,
    lastStatus: null,
    ...over,
  }
}

function armar(opts: { respuesta?: EntregaResultado; callbackUrl?: string | null } = {}) {
  const pedidos: { url: string; cuerpo: string; deliveryId: string }[] = []
  const marcas: { que: string; proxima?: string }[] = []

  const app = unApp({
    scheduleCallbackUrl:
      opts.callbackUrl === undefined
        ? 'https://gym.example/api/messaging/schedule'
        : opts.callbackUrl,
  })

  return {
    pedidos,
    marcas,
    deps: {
      schedules: {
        async upsert() {
          throw new Error('no se usa')
        },
        async deleteByName() {
          return false
        },
        async claimVencidos() {
          return []
        },
        async marcarDisparado(_id: string, _ahora: Date, proxima: Date) {
          marcas.push({ que: 'fired', proxima: proxima.toISOString() })
        },
        async marcarFallido() {
          marcas.push({ que: 'failed' })
        },
        async marcarPerdido(_id: string, _ahora: Date, proxima: Date) {
          marcas.push({ que: 'missed', proxima: proxima.toISOString() })
        },
      },
      apps: createFakeAppsRepo([{ hash: 'h', app }]),
      delivery: {
        async entregar(p: {
          url: string
          cuerpo: string
          deliveryId: string
        }) {
          pedidos.push({
            url: p.url,
            cuerpo: p.cuerpo,
            deliveryId: p.deliveryId,
          })
          return opts.respuesta ?? { ok: true, status: 200 }
        },
      },
      secrets: () => 'secreto',
      now: () => AHORA,
    },
  }
}

describe('dispararProgramado', () => {
  it('postea al schedule_callback_url y NO compone el mensaje', async () => {
    const { deps, pedidos } = armar()
    expect(await dispararProgramado(deps, unSchedule(), AGENDADO)).toBe('fired')

    expect(pedidos[0]?.url).toBe('https://gym.example/api/messaging/schedule')
    const cuerpo = JSON.parse(pedidos[0]?.cuerpo ?? '{}') as Record<string, unknown>
    expect(cuerpo).toEqual({
      scheduleId: 'sch-1',
      name: 'checkin-nocturno',
      userId: 'user-1',
      firedAt: AHORA.toISOString(),
    })
    // Ni texto ni plantilla: la app arma el mensaje.
    expect(pedidos[0]?.cuerpo).not.toContain('text')
  })

  it('usa un deliveryId estable para que un reintento no duplique el aviso', async () => {
    const { deps, pedidos } = armar()
    await dispararProgramado(deps, unSchedule(), AGENDADO)
    await dispararProgramado(deps, unSchedule(), AGENDADO)
    expect(pedidos[0]?.deliveryId).toBe(pedidos[1]?.deliveryId)
  })

  it('agenda la próxima ejecución al disparar', async () => {
    const { deps, marcas } = armar()
    await dispararProgramado(deps, unSchedule(), AGENDADO)
    expect(marcas[0]?.que).toBe('fired')
    expect(marcas[0]?.proxima).toBe('2026-08-04T01:00:00.000Z')
  })

  it('no avanza next_run_at si el callback falla', async () => {
    // El tick siguiente tiene que reintentar: una app fría es el caso normal.
    const { deps, marcas } = armar({
      respuesta: { ok: false, status: 500, error: 'la app respondió 500' },
    })
    expect(await dispararProgramado(deps, unSchedule(), AGENDADO)).toBe('failed')
    expect(marcas[0]).toEqual({ que: 'failed' })
  })

  it('se da por perdido pasada la ventana de gracia', async () => {
    const viejo = new Date(AHORA.getTime() - GRACIA_MS - 1000).toISOString()
    const { deps, marcas, pedidos } = armar()

    expect(await dispararProgramado(deps, unSchedule(), viejo)).toBe('missed')
    expect(pedidos).toEqual([])
    expect(marcas[0]?.que).toBe('missed')
  })

  it('no dispara si la app no tiene callback configurado', async () => {
    const { deps, pedidos } = armar({ callbackUrl: null })
    expect(await dispararProgramado(deps, unSchedule(), AGENDADO)).toBe('skipped')
    expect(pedidos).toEqual([])
  })

  it('marca fallido si la expresión cron dejó de ser válida', async () => {
    const { deps, pedidos } = armar()
    const roto = unSchedule({ cron: 'esto no es cron' })
    expect(await dispararProgramado(deps, roto, AGENDADO)).toBe('failed')
    expect(pedidos).toEqual([])
  })
})
```

- [ ] **Step 3: Correr los tests y commitear**

```bash
DATABASE_URL='' bun run test src/schedules/
```

Esperado: PASS.

```bash
git add src/schedules/ && git commit -m "feat: disparo de programados con callback firmado"
```

---

## Task 6: Las rutas y el tick

**Files:**
- Create: `src/routes/schedules.ts`
- Modify: `src/routes/internal.ts`, `src/create-app.ts`, `src/index.ts`, `src/test-support/fake-deps.ts`

- [ ] **Step 1: Escribir las rutas**

`src/routes/schedules.ts`:

```ts
import { Hono } from 'hono'
import * as z from 'zod'
import type { SchedulesRepo } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { cronValido, proximaEjecucion, zonaValida } from '../schedules/cron.js'

const cuerpoSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(64),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
})

export interface ScheduleDeps {
  schedules: SchedulesRepo
  now: () => Date
}

export function scheduleRoutes(deps: ScheduleDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.post('/v1/schedules', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = cuerpoSchema.safeParse(crudo)
    if (!parseado.success) return c.json({ code: 'invalid_request' }, 400)

    const { userId, name, cron, timezone } = parseado.data

    // Se valida ANTES de guardar: un cron inválido guardado sería un
    // programado que nunca dispara y que nadie mira hasta que falta el aviso.
    if (!cronValido(cron)) return c.json({ code: 'invalid_cron' }, 400)
    if (!zonaValida(timezone)) return c.json({ code: 'invalid_timezone' }, 400)

    const proxima = proximaEjecucion(cron, timezone, deps.now())
    if (!proxima) return c.json({ code: 'invalid_cron' }, 400)

    const app = c.get('app')
    const schedule = await deps.schedules.upsert({
      appId: app.id,
      appUserId: userId,
      name,
      cron,
      timezone,
      nextRunAt: proxima,
    })

    return c.json(
      {
        scheduleId: schedule.id,
        name: schedule.name,
        nextRunAt: schedule.nextRunAt,
      },
      201,
    )
  })

  rutas.delete('/v1/schedules/:name', async (c) => {
    const app = c.get('app')
    const userId = c.req.query('userId')
    // El programado es de un usuario, no de la app: sin userId no se sabe
    // cuál dar de baja.
    if (!userId) return c.json({ code: 'invalid_request' }, 400)

    const borrado = await deps.schedules.deleteByName(
      app.id,
      userId,
      c.req.param('name'),
    )
    return c.json({ deleted: borrado })
  })

  return rutas
}
```

- [ ] **Step 2: Sumar el disparo al tick**

En `src/routes/internal.ts`, extendé el handler de `/internal/tick`:

```ts
    const programados = await deps.schedules.claimVencidos(deps.now(), LOTE)
    let disparados = 0
    for (const { schedule, agendadoPara } of programados) {
      const r = await dispararProgramado(deps, schedule, agendadoPara)
      if (r === 'fired') disparados += 1
    }
```

y sumalo a la respuesta: `{ procesados, entregados, fallidos, disparados }`.

`internalRoutes` pasa a recibir `DeliverDeps & FireDeps`.

- [ ] **Step 3: Cablear**

En `src/create-app.ts` sumá `schedules: SchedulesRepo` a `Deps` y montá
`v1.route('/', scheduleRoutes(deps))`. En `src/index.ts`,
`schedules: createSchedulesRepo(sql)`. En `fake-deps.ts`, un doble.

- [ ] **Step 4: Verificar todo**

```bash
bun run typecheck && bun run lint && DATABASE_URL='' bun run test
```

```bash
bun --bun x vercel build --yes >/dev/null 2>&1 && grep handler .vercel/output/functions/index.func/.vc-config.json
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: rutas de schedules y disparo desde el tick"
```

---

## Task 7: Verificación contra producción

- [ ] **Step 1: Configurar el `schedule_callback_url` de gym-tracker**

Hoy es `NULL`, así que ningún programado suyo dispararía.

```sql
UPDATE apps
SET schedule_callback_url = 'https://gym-tracker-brown-one.vercel.app/api/messaging/schedule'
WHERE slug = 'gym-tracker';
```

- [ ] **Step 2: Registrar un programado de prueba a un minuto vista**

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/v1/schedules \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"fe35defa-f188-4e2e-978e-36f5d748abbc","name":"prueba","cron":"*/2 * * * *","timezone":"America/Argentina/Buenos_Aires"}'
```

Esperado: `201` con `scheduleId` y un `nextRunAt` a menos de dos minutos.

- [ ] **Step 3: Verificar el disparo**

El ticker corre cada 15 minutos, así que el disparo puede tardar. Consultá:

```sql
SELECT name, cron, timezone, next_run_at, last_run_at, last_status
FROM schedules ORDER BY created_at DESC;
```

Esperado: `last_status = 'fired'` una vez que el ticker pase. Mientras
GymTracker no tenga el endpoint `/api/messaging/schedule`, va a quedar en
`failed` — eso **también** es una verificación válida: prueba que comm-tool
disparó y que el callback llegó a destino.

- [ ] **Step 4: Dar de baja el programado de prueba**

```bash
curl -s -X DELETE "https://communication-tool-beta.vercel.app/v1/schedules/prueba?userId=fe35defa-f188-4e2e-978e-36f5d748abbc" \
  -H "Authorization: Bearer $(grep '^GYM_API_KEY=' .env | cut -d= -f2-)"
```

Esperado: `{"deleted":true}`.

---

## Verificación de la fase

- [ ] `bun run lint && bun run typecheck && bun run test` en verde.
- [ ] `bun run db:migrate` reporta `Sin migraciones pendientes (4 aplicadas).`
- [ ] `proximaEjecucion('0 22 * * *', 'America/Argentina/Buenos_Aires', …)` da las 01:00 UTC del día siguiente.
- [ ] La misma expresión en dos zonas distintas da resultados distintos.
- [ ] Un cron inválido devuelve `400 invalid_cron`, no un 500.
- [ ] Un programado que falla **no** avanza su `next_run_at`.
- [ ] Pasada la hora de gracia se marca `missed` y salta a la próxima ocurrencia.
- [ ] El cuerpo del callback **no** contiene texto: solo `scheduleId`, `name`, `userId` y `firedAt`.
- [ ] Un programado real dispara en producción y queda registrado en `last_status`.

El que cierra la fase es el de las 22:00 de Buenos Aires: si esa conversión
está mal, el check-in llega tres horas antes y nadie se entera hasta que alguien
mira el reloj.

## Lo que sigue

**GymTracker construye el check-in sobre el scheduler**, en una sola pasada:
`/api/messaging/schedule` que valida el HMAC, arma el mensaje con los datos del
día y llama a `/v1/messages`. Se ahorra el paso intermedio por Vercel Cron y
el jitter de una hora que su spec ya daba por perdido.
