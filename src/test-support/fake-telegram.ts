import type { TelegramClient } from '../channels/telegram/client.js'

/**
 * Un cliente de Telegram que no hace nada. Cada test pisa sólo lo que mide:
 *
 *     const telegram: TelegramClient = {
 *       ...telegramFalso(),
 *       async sendMessage() { ... },
 *     }
 */
export function telegramFalso(): TelegramClient {
  return {
    async sendMessage() {
      return { messageId: '1' }
    },
    async answerCallbackQuery() {},
    async editMessageText() {},
  }
}
