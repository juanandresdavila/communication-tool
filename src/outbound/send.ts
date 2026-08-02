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

  // findByAppAndChannel ya filtra por `active`: no hace falta chequearlo acá.
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
 *
 * Con clave nula `claim` nunca devuelve null, así que esta rama no debería
 * alcanzarse; si alguna vez ocurriera, `in_progress` es la respuesta segura.
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
