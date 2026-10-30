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
    // Sin próxima ejecución (expresión inválida o un patrón que ya no ocurre)
    // el estado es terminal: reintentar no la hace aparecer. Restaurar el
    // horario, como en un fallo de entrega, la devolvería al claim en cada
    // tick hasta que la ventana de gracia la diera por perdida. Queda
    // inactivo y visible en `last_status`.
    await deps.schedules.marcarSinProxima(schedule.id, ahora)
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

  // Sin el secreto no hay con qué firmar: es un fallo del disparo, no una
  // excepción. Se restaura la hora para que la gracia lo dé por perdido en
  // vez de dejar el programado reclamado en loop. El motivo va al log: sin él
  // el programado queda `failed` sin rastro. El lector nombra la variable,
  // nunca el valor.
  let firma: string
  try {
    firma = headerDeFirma(
      deps.secrets(app.deliverySecretEnv),
      cuerpo,
      Math.floor(ahora.getTime() / 1000),
    )
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e)
    console.error(`programado ${schedule.id}: no se pudo firmar: ${motivo}`)
    await deps.schedules.marcarFallido(schedule.id, ahora, agendado)
    return 'failed'
  }

  const resultado = await deps.delivery.entregar({
    url: app.scheduleCallbackUrl,
    cuerpo,
    firma,
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
