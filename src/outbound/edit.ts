import type { Button } from '../client/types.js'
import type { SendDeps } from './send.js'

export type EditDeps = Pick<SendDeps, 'bots' | 'contacts' | 'telegram' | 'secrets'>

export interface PedidoEdicion {
  userId: string
  /** El id DEL PROVEEDOR, el que devolvió el envío. */
  messageId: string
  text: string
  /** null saca el teclado que tenía el mensaje. */
  buttons: Button[][] | null
}

export type ResultadoEdicion =
  | { estado: 'edited' }
  | { estado: 'not_linked' }
  | { estado: 'no_bot' }
  | { estado: 'edit_failed'; error: string }

/**
 * ⚠️ La descripción exacta de este rechazo NO figura en la doc de la Bot API:
 * se confirma con una llamada real el día del deploy (plan del 22/09/2026,
 * Task 12). Si Telegram la cambia, un doble toque empieza a dar 502.
 */
const NO_MODIFICADO = /message is not modified/i

/**
 * No hace falta comprobar de quién es el mensaje: cada app tiene su propio
 * bot, y Telegram sólo deja editar mensajes de ese bot en ese chat. Por la
 * misma razón una edición no crea fila en outbound_messages: no es un mensaje
 * nuevo.
 */
export async function editarSaliente(
  deps: EditDeps,
  appId: string,
  pedido: PedidoEdicion,
): Promise<ResultadoEdicion> {
  const contacto = await deps.contacts.findByAppUserId(
    appId,
    'telegram',
    pedido.userId,
  )
  if (!contacto) return { estado: 'not_linked' }

  const bot = await deps.bots.findByAppAndChannel(appId, 'telegram')
  if (!bot) return { estado: 'no_bot' }

  try {
    await deps.telegram.editMessageText(
      deps.secrets(bot.tokenEnv),
      contacto.externalId,
      pedido.messageId,
      pedido.text,
      pedido.buttons,
    )
    return { estado: 'edited' }
  } catch (error) {
    const detalle = (error as Error).message
    if (NO_MODIFICADO.test(detalle)) return { estado: 'edited' }
    return { estado: 'edit_failed', error: detalle }
  }
}
