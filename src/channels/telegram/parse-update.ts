import type {
  Comando,
  UpdateDeMensaje,
  UpdateDeToque,
  UpdateNormalizado,
} from './types.js'

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseTelegramUpdate(crudo: unknown): UpdateNormalizado | null {
  if (!esObjeto(crudo)) return null

  const updateId = crudo['update_id']
  if (typeof updateId !== 'number') return null

  const message = crudo['message']
  if (esObjeto(message)) return mensaje(String(updateId), message)

  const toque = crudo['callback_query']
  if (esObjeto(toque)) return callback(String(updateId), toque)

  return null
}

function idDeChat(chat: unknown): string | null {
  if (!esObjeto(chat)) return null
  const id = chat['id']
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null
}

function mensaje(
  updateId: string,
  message: Record<string, unknown>,
): UpdateDeMensaje | null {
  const chatId = idDeChat(message['chat'])
  const messageId = message['message_id']
  if (chatId === null || typeof messageId !== 'number') return null

  const replyTo = message['reply_to_message']
  const replyToId = esObjeto(replyTo) ? replyTo['message_id'] : undefined

  return {
    tipo: 'message',
    updateId,
    chatId,
    messageId: String(messageId),
    // Un mensaje sin texto (foto, audio) llega con text vacío y no se
    // descarta: el spec dice que la app decide qué hacer con él.
    text: typeof message['text'] === 'string' ? message['text'] : '',
    replyToMessageId:
      typeof replyToId === 'number' ? String(replyToId) : undefined,
  }
}

function callback(
  updateId: string,
  toque: Record<string, unknown>,
): UpdateDeToque | null {
  const id = toque['id']
  const data = toque['data']
  const message = toque['message']
  // Sin `message`, el botón era de un mensaje inline y no hay chat al que
  // resolver. Sin `data`, es un juego. comm-tool no manda ninguno de los dos.
  if (typeof id !== 'string' || typeof data !== 'string' || !esObjeto(message)) {
    return null
  }

  // Un mensaje "inaccesible" (date 0) igual trae chat y message_id.
  const chatId = idDeChat(message['chat'])
  const messageId = message['message_id']
  if (chatId === null || typeof messageId !== 'number') return null

  return {
    tipo: 'callback',
    updateId,
    chatId,
    messageId: String(messageId),
    callbackId: id,
    data,
  }
}

export function parseCommand(texto: string): Comando | null {
  if (!texto.startsWith('/')) return null

  const espacio = texto.indexOf(' ')
  const cabeza = espacio === -1 ? texto : texto.slice(0, espacio)
  const args = espacio === -1 ? '' : texto.slice(espacio + 1).trim()

  // En grupos, Telegram manda /comando@NombreDelBot.
  const nombre = cabeza.slice(1).split('@')[0]?.toLowerCase() ?? ''
  if (nombre === '') return null

  return { nombre, args }
}
