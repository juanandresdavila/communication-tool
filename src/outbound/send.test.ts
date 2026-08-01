import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact, OutboundMessage } from '../db/ports.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unBot,
  unContacto,
  unSaliente,
} from '../test-support/fake-repos.js'
import type { PedidoSaliente } from './send.js'
import { enviarSaliente } from './send.js'

const APP_ID = 'app-1'

function unPedido(over: Partial<PedidoSaliente> = {}): PedidoSaliente {
  return {
    userId: 'user-1',
    text: 'anotado: banca 4x10 60',
    kind: 'reply',
    replyToMessageId: null,
    template: null,
    idempotencyKey: null,
    ...over,
  }
}

function armar(
  opts: {
    contactos?: Contact[]
    bots?: Bot[]
    salientes?: OutboundMessage[]
    fallas?: number
  } = {},
) {
  const enviados: {
    token: string
    chatId: string
    text: string
    replyToMessageId: string | null | undefined
  }[] = []
  let fallasRestantes = opts.fallas ?? 0

  const telegram: TelegramClient = {
    async sendMessage(token, chatId, text, replyToMessageId) {
      enviados.push({ token, chatId, text, replyToMessageId })
      if (fallasRestantes > 0) {
        fallasRestantes -= 1
        throw new Error('Telegram rechazó sendMessage: chat not found')
      }
      return { messageId: `tg-${enviados.length}` }
    },
  }

  const outbound = createFakeOutboundMessagesRepo(opts.salientes ?? [])

  return {
    enviados,
    outbound,
    deps: {
      bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
      contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
      outbound,
      telegram,
      // Devolver el nombre permite comprobar que el token salió de
      // bots.token_env y no de otro lado.
      secrets: (nombre: string) => `valor-de-${nombre}`,
    },
  }
}

describe('enviarSaliente', () => {
  it('manda al chat del contacto con el token del bot de la app', async () => {
    const { deps, enviados } = armar()

    const resultado = await enviarSaliente(deps, APP_ID, unPedido())

    expect(resultado.estado).toBe('sent')
    expect(enviados[0]?.token).toBe('valor-de-TELEGRAM_TOKEN_GYM')
    expect(enviados[0]?.chatId).toBe('12345')
    expect(enviados[0]?.text).toBe('anotado: banca 4x10 60')
  })

  it('devuelve el id del proveedor y deja la fila en sent', async () => {
    const { deps, outbound } = armar()

    const resultado = await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ idempotencyKey: 'k-1' }),
    )

    if (resultado.estado !== 'sent') throw new Error('no se envió')
    expect(resultado.providerMessageId).toBe('tg-1')

    const guardado = await outbound.findByIdempotencyKey(APP_ID, 'k-1')
    expect(guardado?.status).toBe('sent')
    expect(guardado?.providerMessageId).toBe('tg-1')
  })

  it('guarda kind, template y el mensaje al que responde', async () => {
    const { deps, outbound, enviados } = armar()

    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({
        kind: 'notification',
        template: { name: 'checkin', vars: { hora: '22:00' } },
        replyToMessageId: '55',
        idempotencyKey: 'k-2',
      }),
    )

    const guardado = await outbound.findByIdempotencyKey(APP_ID, 'k-2')
    expect(guardado?.kind).toBe('notification')
    expect(guardado?.template).toEqual({
      name: 'checkin',
      vars: { hora: '22:00' },
    })
    expect(enviados[0]?.replyToMessageId).toBe('55')
  })

  it('no manda nada si el usuario no está vinculado', async () => {
    const { deps, enviados } = armar({ contactos: [] })

    expect((await enviarSaliente(deps, APP_ID, unPedido())).estado).toBe(
      'not_linked',
    )
    expect(enviados).toEqual([])
  })

  it('no manda nada si la app no tiene bot activo en el canal', async () => {
    const { deps, enviados } = armar({ bots: [unBot({ active: false })] })

    expect((await enviarSaliente(deps, APP_ID, unPedido())).estado).toBe(
      'no_bot',
    )
    expect(enviados).toEqual([])
  })

  it('con la misma clave manda una sola vez y repite la respuesta', async () => {
    // Es la capa 3 de idempotencia del spec: la app reintenta y no se manda
    // dos veces.
    const { deps, enviados } = armar()
    const pedido = unPedido({ idempotencyKey: 'k-3' })

    const primero = await enviarSaliente(deps, APP_ID, pedido)
    const segundo = await enviarSaliente(deps, APP_ID, pedido)

    expect(enviados).toHaveLength(1)
    expect(primero.estado).toBe('sent')
    expect(segundo.estado).toBe('duplicate')
    if (primero.estado !== 'sent' || segundo.estado !== 'duplicate') {
      throw new Error('estados inesperados')
    }
    expect(segundo.providerMessageId).toBe(primero.providerMessageId)
    expect(segundo.mensaje.id).toBe(primero.mensaje.id)
  })

  it('sin clave, dos llamadas iguales mandan dos mensajes', async () => {
    // La idempotencia es opt-in: sin clave no hay nada que deduplicar, y
    // suprimir el segundo envío sería adivinar.
    const { deps, enviados } = armar()

    await enviarSaliente(deps, APP_ID, unPedido())
    await enviarSaliente(deps, APP_ID, unPedido())

    expect(enviados).toHaveLength(2)
  })

  it('marca fallido y no explota si Telegram rechaza', async () => {
    const { deps, outbound } = armar({ fallas: 1 })

    const resultado = await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ idempotencyKey: 'k-4' }),
    )

    expect(resultado.estado).toBe('send_failed')
    if (resultado.estado !== 'send_failed') throw new Error('estado inesperado')
    expect(resultado.error).toMatch(/chat not found/)

    const guardado = await outbound.findByIdempotencyKey(APP_ID, 'k-4')
    expect(guardado?.status).toBe('failed')
    expect(guardado?.providerMessageId).toBeNull()
  })

  it('reintentar con la misma clave después de un fallo sí manda', async () => {
    // Un envío fallido nunca llegó al chat, así que la clave no tiene nada que
    // proteger: bloquear el reintento dejaría a la app sin salida.
    const { deps, enviados } = armar({ fallas: 1 })
    const pedido = unPedido({ idempotencyKey: 'k-5' })

    expect((await enviarSaliente(deps, APP_ID, pedido)).estado).toBe(
      'send_failed',
    )
    expect((await enviarSaliente(deps, APP_ID, pedido)).estado).toBe('sent')
    expect(enviados).toHaveLength(2)
  })

  it('un envío en vuelo con la misma clave devuelve in_progress', async () => {
    // La fila quedó en `sending` porque la invocación anterior se murió entre
    // la reserva y la marca. No sabemos si el mensaje salió: mandarlo de nuevo
    // podría duplicarlo, así que se avisa y decide la app.
    const { deps, enviados } = armar({
      salientes: [
        unSaliente({ id: 'out-99', status: 'sending', idempotencyKey: 'k-6' }),
      ],
    })

    const resultado = await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ idempotencyKey: 'k-6' }),
    )

    expect(resultado.estado).toBe('in_progress')
    expect(enviados).toEqual([])
  })

  it('reenvía el texto reservado, no el del pedido nuevo', async () => {
    const { deps, enviados } = armar({ fallas: 1 })

    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ text: 'el original', idempotencyKey: 'k-7' }),
    )
    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ text: 'otro texto', idempotencyKey: 'k-7' }),
    )

    expect(enviados[1]?.text).toBe('el original')
  })
})
