import type {
  AppsRepo,
  InboundMessage,
  InboundMessagesRepo,
} from '../db/ports.js'
import type { SecretReader } from '../secrets.js'
import { esperaInmediata, proximoIntentoMs } from './backoff.js'
import type { DeliveryClient } from './client.js'
import { headerDeFirma } from '../client/signature.js'

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
