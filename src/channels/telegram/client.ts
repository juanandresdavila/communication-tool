export interface TelegramClient {
  sendMessage(
    token: string,
    chatId: string,
    text: string,
  ): Promise<{ messageId: string }>
}

export type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export function createTelegramClient(fetchImpl: Fetch = fetch): TelegramClient {
  return {
    async sendMessage(token, chatId, text) {
      const res = await fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      )

      const cuerpo = (await res.json().catch(() => null)) as {
        ok?: boolean
        result?: { message_id?: number }
        description?: string
      } | null

      if (!res.ok || cuerpo?.ok !== true) {
        // El token va en la URL: nunca se incluye el detalle de la request en
        // el error, solo la descripción que devuelve Telegram.
        throw new Error(
          `Telegram rechazó sendMessage: ${cuerpo?.description ?? res.status}`,
        )
      }

      return { messageId: String(cuerpo.result?.message_id ?? '') }
    },
  }
}
