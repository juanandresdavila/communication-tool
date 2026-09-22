import type { Button } from '../../client/types.js'

export interface TelegramClient {
  sendMessage(
    token: string,
    chatId: string,
    text: string,
    replyToMessageId?: string | null,
    botones?: Button[][] | null,
  ): Promise<{ messageId: string }>
  /**
   * Obligatorio después de cada toque, aunque no haya nada que avisar: sin él
   * el botón queda con la barrita de carga (doc de la Bot API).
   */
  answerCallbackQuery(token: string, callbackId: string): Promise<void>
  editMessageText(
    token: string,
    chatId: string,
    messageId: string,
    text: string,
    botones?: Button[][] | null,
  ): Promise<void>
}

export type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Mismo criterio que TIMEOUT_ENTREGA_MS en delivery/deliver.ts. Sin esto, un
 * api.telegram.org colgado cuelga el request que lo llamó: el webhook retenía
 * un slot del pool de Telegram y el saliente quedaba en `sending` sin marcar.
 */
export const TIMEOUT_TELEGRAM_MS = 10_000

/**
 * Telegram pide un entero. Un id que no lo sea se descarta en vez de romper el
 * envío: el mensaje sin hilo llega, y el mensaje rechazado no.
 */
function replyParameters(
  replyToMessageId: string | null | undefined,
): Record<string, unknown> {
  if (replyToMessageId === null || replyToMessageId === undefined) return {}
  const numero = Number(replyToMessageId)
  if (!Number.isInteger(numero)) return {}
  return {
    reply_parameters: {
      message_id: numero,
      allow_sending_without_reply: true,
    },
  }
}

/** Los dos `InlineKeyboardButton` de Telegram que comm-tool usa. */
type BotonDeTelegram =
  | { text: string; url: string }
  | { text: string; callback_data: string }

/**
 * `Button` del contrato → `InlineKeyboardButton` de Telegram. La validación
 * (exactamente uno de data o url, los 64 bytes) es de la ruta, no de acá.
 */
export function tecladoInline(botones: Button[][]): {
  inline_keyboard: BotonDeTelegram[][]
} {
  return {
    inline_keyboard: botones.map((fila) =>
      fila.map((b) =>
        b.url !== undefined
          ? { text: b.text, url: b.url }
          : { text: b.text, callback_data: b.data ?? '' },
      ),
    ),
  }
}

export function createTelegramClient(
  fetchImpl: Fetch = fetch,
  timeoutMs: number = TIMEOUT_TELEGRAM_MS,
): TelegramClient {
  async function llamar(
    token: string,
    metodo: string,
    cuerpo: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const respuesta = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: unknown
      description?: string
    } | null

    if (!res.ok || respuesta?.ok !== true) {
      // El token va en la URL: nunca se incluye el detalle de la request en
      // el error, solo la descripción que devuelve Telegram.
      throw new Error(
        `Telegram rechazó ${metodo}: ${respuesta?.description ?? res.status}`,
      )
    }

    return respuesta.result
  }

  return {
    async sendMessage(token, chatId, text, replyToMessageId, botones) {
      const resultado = (await llamar(token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...replyParameters(replyToMessageId),
        ...(botones && botones.length > 0
          ? { reply_markup: tecladoInline(botones) }
          : {}),
      })) as { message_id?: number } | undefined

      return { messageId: String(resultado?.message_id ?? '') }
    },

    async answerCallbackQuery(token, callbackId) {
      await llamar(token, 'answerCallbackQuery', {
        callback_query_id: callbackId,
      })
    },

    async editMessageText(token, chatId, messageId, text, botones) {
      await llamar(token, 'editMessageText', {
        chat_id: chatId,
        // La ruta valida que sea un entero; Telegram lo pide así.
        message_id: Number(messageId),
        text,
        // Siempre explícito: sin botones, un teclado vacío saca el que había.
        reply_markup: tecladoInline(botones ?? []),
      })
    },
  }
}
