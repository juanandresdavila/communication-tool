import { describe, expect, it } from 'vitest'
import { createTelegramClient } from './client.js'

function fetchQueDevuelve(estado: number, cuerpo: unknown) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init })
    return new Response(JSON.stringify(cuerpo), { status: estado })
  }
  return { fake, llamadas }
}

describe('createTelegramClient', () => {
  it('postea a sendMessage y devuelve el id del mensaje', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 77 },
    })
    const cliente = createTelegramClient(fake)

    const resultado = await cliente.sendMessage('TOKEN', '12345', 'hola')

    expect(resultado).toEqual({ messageId: '77' })
    expect(llamadas[0]?.url).toBe(
      'https://api.telegram.org/botTOKEN/sendMessage',
    )
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('manda reply_parameters cuando se responde a un mensaje', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 78 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'dale', '55')

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'dale',
      reply_parameters: {
        message_id: 55,
        // Si el usuario borró el mensaje original, el envío tiene que salir
        // igual: perder la respuesta por eso sería peor que perder el hilo.
        allow_sending_without_reply: true,
      },
    })
  })

  it('no manda reply_parameters si no hay a qué responder', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 79 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola', null)

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('ignora un replyToMessageId que no es un número', async () => {
    // Telegram exige un entero. Mandarle basura hace fallar el envío entero;
    // mandarlo sin reply llega, que es lo que importa.
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 80 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola', 'no-es-un-numero')

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('falla si Telegram responde con error', async () => {
    const { fake } = fetchQueDevuelve(400, {
      ok: false,
      description: 'chat not found',
    })
    const cliente = createTelegramClient(fake)

    await expect(cliente.sendMessage('TOKEN', '1', 'hola')).rejects.toThrow(
      /chat not found/,
    )
  })

  it('no incluye el token en el mensaje de error', async () => {
    const { fake } = fetchQueDevuelve(401, { ok: false, description: 'nope' })
    const cliente = createTelegramClient(fake)

    await expect(
      cliente.sendMessage('TOKEN_SECRETO', '1', 'hola'),
    ).rejects.toThrow(/^(?!.*TOKEN_SECRETO).*$/s)
  })
})
