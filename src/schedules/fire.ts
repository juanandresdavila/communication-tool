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
  const agendado = new Date(agendadoPara)

  const proxima = proximaEjecucion(schedule.cron, schedule.timezone, ahora)
  if (!proxima) {
    // La expresión dejó de ser válida. Se marca fallido y se restaura el
    // horario: queda visible en `last_status` en vez de desaparecer.
    await deps.schedules.marcarFallido(schedule.id, ahora, agendado)
    return 'failed'
  }

  // Fuera de la ventana de gracia: el aviso de esa hora ya no sirve. Se salta
  // a la próxima ocurrencia en vez de mandarlo tardísimo.
  if (ahora.getTime() - agendado.getTime() > GRACIA_MS) {
    await deps.schedules.marcarPerdido(schedule.id, ahora, proxima)
    return 'missed'
  }

  const app = await deps.apps.findById(schedule.appId)
  if (!app || !app.active || !app.scheduleCallbackUrl) {
    await deps.schedules.marcarFallido(schedule.id, ahora, agendado)
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
    // Estable a propósito: si un reintento del mismo disparo llega dos veces,
    // la app lo deduplica por este id. Un uuid nuevo por intento haría que el
    // check-in se mandara dos veces.
    deliveryId: `${schedule.id}:${agendadoPara}`,
    timeoutMs: TIMEOUT_CALLBACK_MS,
  })

  if (!resultado.ok) {
    await deps.schedules.marcarFallido(schedule.id, ahora, agendado)
    return 'failed'
  }

  await deps.schedules.marcarDisparado(schedule.id, ahora, proxima)
  return 'fired'
}
