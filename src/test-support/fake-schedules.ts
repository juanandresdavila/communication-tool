import type { Schedule, SchedulesRepo } from '../db/ports.js'

export function unSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    appId: 'app-1',
    appUserId: 'user-1',
    name: 'checkin-nocturno',
    cron: '0 22 * * *',
    timezone: 'America/Argentina/Buenos_Aires',
    active: true,
    nextRunAt: '2026-08-03T01:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    ...over,
  }
}

/** Cuánto se reserva un programado mientras un tick lo dispara. */
const LEASE_MS = 5 * 60_000

export function createFakeSchedulesRepo(
  inicial: Schedule[] = [],
): SchedulesRepo {
  // Copias, no referencias, igual que los otros dobles.
  const filas = inicial.map((s) => ({ ...s }))
  let siguienteId = inicial.length + 1

  return {
    async upsert(input) {
      const existente = filas.find(
        (s) =>
          s.appId === input.appId &&
          s.appUserId === input.appUserId &&
          s.name === input.name,
      )
      if (existente) {
        existente.cron = input.cron
        existente.timezone = input.timezone
        existente.nextRunAt = input.nextRunAt.toISOString()
        existente.active = true
        return { ...existente }
      }

      const creado: Schedule = {
        id: `sch-${siguienteId++}`,
        appId: input.appId,
        appUserId: input.appUserId,
        name: input.name,
        cron: input.cron,
        timezone: input.timezone,
        active: true,
        nextRunAt: input.nextRunAt.toISOString(),
        lastRunAt: null,
        lastStatus: null,
      }
      filas.push(creado)
      return { ...creado }
    },

    async deleteByName(appId, appUserId, name) {
      const i = filas.findIndex(
        (s) =>
          s.appId === appId && s.appUserId === appUserId && s.name === name,
      )
      if (i === -1) return false
      filas.splice(i, 1)
      return true
    },

    async claimVencidos(ahora, limite) {
      const elegibles = filas
        .filter(
          (s) =>
            s.active && s.nextRunAt !== null && new Date(s.nextRunAt) <= ahora,
        )
        .slice(0, limite)

      // Se captura el horario original ANTES de pisarlo con el lease, igual
      // que el CTE del repositorio real.
      const tomados = elegibles.map((s) => ({
        schedule: { ...s },
        agendadoPara: s.nextRunAt ?? '',
      }))
      for (const s of elegibles) {
        s.nextRunAt = new Date(ahora.getTime() + LEASE_MS).toISOString()
      }
      return tomados
    },

    async marcarDisparado(id, ahora, proxima) {
      const s = filas.find((x) => x.id === id)
      if (!s) return
      s.lastRunAt = ahora.toISOString()
      s.lastStatus = 'fired'
      s.nextRunAt = proxima.toISOString()
    },

    async marcarFallido(id, ahora, agendadoPara) {
      const s = filas.find((x) => x.id === id)
      if (!s) return
      s.lastRunAt = ahora.toISOString()
      s.lastStatus = 'failed'
      // Restaura el horario original: sin esto la ventana de gracia no vence.
      s.nextRunAt = agendadoPara.toISOString()
    },

    async marcarPerdido(id, ahora, proxima) {
      const s = filas.find((x) => x.id === id)
      if (!s) return
      s.lastRunAt = ahora.toISOString()
      s.lastStatus = 'missed'
      s.nextRunAt = proxima.toISOString()
    },
  }
}
