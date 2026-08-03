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
      // El CTE captura next_run_at ANTES del UPDATE. Sin esto el RETURNING
      // devolvería el lease y se perdería para cuándo estaba agendado, que es
      // lo que decide si el disparo todavía entra en la ventana de gracia.
      //
      // SKIP LOCKED, igual que en entrantes: con el driver HTTP no hay
      // transacciones, así que la atomicidad vive en el SQL.
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

    async marcarDisparado(id, ahora, proxima) {
      await sql`
        UPDATE schedules
        SET last_run_at = ${ahora.toISOString()},
            last_status = 'fired',
            next_run_at = ${proxima.toISOString()}
        WHERE id = ${id}
      `
    },

    async marcarFallido(id, ahora, agendadoPara) {
      // Se restaura el horario original, no se deja el lease: ver la nota del
      // puerto. Sin esto la ventana de gracia nunca vence.
      await sql`
        UPDATE schedules
        SET last_run_at = ${ahora.toISOString()},
            last_status = 'failed',
            next_run_at = ${agendadoPara.toISOString()}
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
