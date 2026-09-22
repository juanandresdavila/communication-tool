import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact } from '../db/ports.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { telegramFalso } from '../test-support/fake-telegram.js'
import { editarSaliente, type PedidoEdicion } from './edit.js'

const APP_ID = 'app-1'

function unaEdicion(over: Partial<PedidoEdicion> = {}): PedidoEdicion {
  return {
    userId: 'user-1',
    messageId: '77',
    text: '¿En qué proyecto?',
    buttons: null,
    ...over,
  }
}

function armar(
  opts: { contactos?: Contact[]; bots?: Bot[]; rechazo?: string } = {},
) {
  const ediciones: {
    token: string
    chatId: string
    messageId: string
    text: string
    botones: unknown
  }[] = []

  const telegram: TelegramClient = {
    ...telegramFalso(),
    async editMessageText(token, chatId, messageId, text, botones) {
      ediciones.push({ token, chatId, messageId, text, botones })
      if (opts.rechazo) {
        throw new Error(`Telegram rechazó editMessageText: ${opts.rechazo}`)
      }
    },
  }

  return {
    ediciones,
    deps: {
      bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
      contacts: createFakeContactsRepo(
        opts.contactos ?? [unContacto({ externalId: '12345' })],
      ),
      telegram,
      secrets: (nombre: string) => `valor-de-${nombre}`,
    },
  }
}

describe('editarSaliente', () => {
  it('edita en el chat del contacto con el token del bot de la app', async () => {
    const { deps, ediciones } = armar()
    const buttons = [[{ text: 'Redes', data: 's1:abc:p:0' }]]

    const r = await editarSaliente(deps, APP_ID, unaEdicion({ buttons }))

    expect(r).toEqual({ estado: 'edited' })
    expect(ediciones).toEqual([
      {
        token: 'valor-de-TELEGRAM_TOKEN_GYM',
        chatId: '12345',
        messageId: '77',
        text: '¿En qué proyecto?',
        botones: buttons,
      },
    ])
  })

  it('no edita nada si el usuario no está vinculado', async () => {
    const { deps, ediciones } = armar({ contactos: [] })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'not_linked',
    })
    expect(ediciones).toEqual([])
  })

  it('no edita nada si la app no tiene bot activo', async () => {
    const { deps } = armar({ bots: [unBot({ active: false })] })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'no_bot',
    })
  })

  it('editar sin cambios cuenta como éxito', async () => {
    // Lo produce un doble toque: el mensaje ya dice lo que se pidió.
    const { deps } = armar({
      rechazo:
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
    })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'edited',
    })
  })

  it('cualquier otro rechazo es edit_failed con el detalle', async () => {
    const { deps } = armar({ rechazo: 'Bad Request: message to edit not found' })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'edit_failed',
      error:
        'Telegram rechazó editMessageText: Bad Request: message to edit not found',
    })
  })
})
