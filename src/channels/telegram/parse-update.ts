import type { Comando, UpdateNormalizado } from './types.js'

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseTelegramUpdate(crudo: unknown): UpdateNormalizado | null {
  if (!esObjeto(crudo)) return null

  const updateId = crudo['update_id']
  const message = crudo['message']
  if (typeof updateId !== 'number' || !esObjeto(message)) return null

  const chat = message['chat']
  const messageId = message['message_id']
  if (!esObjeto(chat) || typeof messageId !== 'number') return null

  const chatId = chat['id']
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return null

  const replyTo = message['reply_to_message']
  const replyToId = esObjeto(replyTo) ? replyTo['message_id'] : undefined

  return {
    updateId: String(updateId),
    chatId: String(chatId),
    messageId: String(messageId),
    // Un mensaje sin texto (foto, audio) llega con text vacío y no se
    // descarta: el spec dice que la app decide qué hacer con él.
    text: typeof message['text'] === 'string' ? message['text'] : '',
    replyToMessageId:
      typeof replyToId === 'number' ? String(replyToId) : undefined,
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
