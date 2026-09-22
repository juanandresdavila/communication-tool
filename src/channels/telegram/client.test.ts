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

  it('le pasa un AbortSignal al fetch', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 81 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola')

    expect(llamadas[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborta el envío cuando vence el timeout', async () => {
    // Un fetch que no resuelve nunca por su cuenta: la única forma de que este
    // test termine es que el cliente lo aborte. Sin AbortSignal, el test cuelga
    // hasta el timeout de Vitest.
    const fake = async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolver, rechazar) => {
        init?.signal?.addEventListener('abort', () => {
          rechazar(new Error('The operation was aborted'))
        })
      })

    const cliente = createTelegramClient(fake, 10)

    await expect(cliente.sendMessage('TOKEN', '1', 'hola')).rejects.toThrow(
      /abort/i,
    )
  })

  it('manda los botones como reply_markup inline', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 82 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', '¿Lo guardo como…?', null, [
      [
        { text: 'Tarea', data: 's1:abc:t:tarea' },
        { text: 'Nota', data: 's1:abc:t:nota' },
      ],
      [{ text: 'Abrir', url: 'https://study.jadd.com.ar' }],
    ])

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: '¿Lo guardo como…?',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Tarea', callback_data: 's1:abc:t:tarea' },
            { text: 'Nota', callback_data: 's1:abc:t:nota' },
          ],
          [{ text: 'Abrir', url: 'https://study.jadd.com.ar' }],
        ],
      },
    })
  })

  it('no manda reply_markup sin botones', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 83 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola', null, null)

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('contesta un toque con answerCallbackQuery', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, { ok: true, result: true })
    const cliente = createTelegramClient(fake)

    await cliente.answerCallbackQuery('TOKEN', 'cb-1')

    expect(llamadas[0]?.url).toBe(
      'https://api.telegram.org/botTOKEN/answerCallbackQuery',
    )
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      callback_query_id: 'cb-1',
    })
    expect(llamadas[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('edita un mensaje con texto y botones nuevos', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 77 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.editMessageText('TOKEN', '12345', '77', '¿En qué proyecto?', [
      [{ text: 'Redes', data: 's1:abc:p:0' }],
    ])

    expect(llamadas[0]?.url).toBe(
      'https://api.telegram.org/botTOKEN/editMessageText',
    )
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      message_id: 77,
      text: '¿En qué proyecto?',
      reply_markup: {
        inline_keyboard: [[{ text: 'Redes', callback_data: 's1:abc:p:0' }]],
      },
    })
  })

  it('al editar sin botones manda un teclado vacío, que saca el que había', async () => {
    // Explícito a propósito: omitir reply_markup también lo saca según la
    // práctica común, pero la doc no lo dice, y un teclado vacío no deja dudas.
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 77 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.editMessageText('TOKEN', '12345', '77', '✅ Guardado', null)

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toMatchObject({
      reply_markup: { inline_keyboard: [] },
    })
  })

  it('al editar, un rechazo de Telegram nombra el método y no el token', async () => {
    const { fake } = fetchQueDevuelve(400, {
      ok: false,
      description: 'Bad Request: message is not modified',
    })
    const cliente = createTelegramClient(fake)

    const intento = cliente.editMessageText('TOKEN_SECRETO', '1', '7', 'x', null)

    await expect(intento).rejects.toThrow(
      /editMessageText: Bad Request: message is not modified/,
    )
    await expect(intento).rejects.toThrow(/^(?!.*TOKEN_SECRETO).*$/s)
  })
})
