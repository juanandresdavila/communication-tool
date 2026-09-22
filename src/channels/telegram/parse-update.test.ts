import { describe, expect, it } from 'vitest'
import { parseCommand, parseTelegramUpdate } from './parse-update.js'

const MENSAJE_DE_TEXTO = {
  update_id: 900_001,
  message: {
    message_id: 42,
    from: { id: 12345, is_bot: false, first_name: 'Juan' },
    chat: { id: 12345, type: 'private' },
    date: 1_785_264_000,
    text: 'banca 4x10 60',
  },
}

describe('parseTelegramUpdate', () => {
  it('extrae chat, texto e ids de un mensaje de texto', () => {
    expect(parseTelegramUpdate(MENSAJE_DE_TEXTO)).toEqual({
      tipo: 'message',
      updateId: '900001',
      chatId: '12345',
      messageId: '42',
      text: 'banca 4x10 60',
      replyToMessageId: undefined,
    })
  })

  it('extrae el mensaje al que se responde', () => {
    const conRespuesta = {
      ...MENSAJE_DE_TEXTO,
      message: {
        ...MENSAJE_DE_TEXTO.message,
        reply_to_message: { message_id: 7 },
      },
    }
    expect(parseTelegramUpdate(conRespuesta)).toMatchObject({
      tipo: 'message',
      replyToMessageId: '7',
    })
  })

  it('devuelve texto vacío para un mensaje sin texto, no null', () => {
    const foto = {
      update_id: 900_002,
      message: {
        message_id: 43,
        chat: { id: 12345, type: 'private' },
        date: 1_785_264_000,
        photo: [{ file_id: 'abc' }],
      },
    }
    expect(parseTelegramUpdate(foto)).toMatchObject({ text: '' })
  })

  const TOQUE = {
    update_id: 900_010,
    callback_query: {
      id: '4382bfdwdsb323b2d9',
      from: { id: 12345, is_bot: false, first_name: 'Juan' },
      message: {
        message_id: 77,
        from: { id: 999, is_bot: true, first_name: 'Study' },
        chat: { id: 12345, type: 'private' },
        date: 1_785_264_000,
        text: '¿Lo guardo como…?',
      },
      chat_instance: '-123',
      data: 's1:k3Jd9aQ2xZ:t:examen',
    },
  }

  it('extrae un toque: chat, mensaje del bot, id del toque y data', () => {
    expect(parseTelegramUpdate(TOQUE)).toEqual({
      tipo: 'callback',
      updateId: '900010',
      chatId: '12345',
      // El mensaje del BOT que tenía el botón, no uno del usuario.
      messageId: '77',
      callbackId: '4382bfdwdsb323b2d9',
      data: 's1:k3Jd9aQ2xZ:t:examen',
    })
  })

  it('lee el toque aunque el mensaje del bot ya sea inaccesible', () => {
    // MaybeInaccessibleMessage: sin texto y con date 0, pero con chat y
    // message_id, que es lo único que hace falta.
    const inaccesible = {
      ...TOQUE,
      callback_query: {
        ...TOQUE.callback_query,
        message: { message_id: 77, chat: { id: 12345, type: 'private' }, date: 0 },
      },
    }
    expect(parseTelegramUpdate(inaccesible)).toMatchObject({
      tipo: 'callback',
      chatId: '12345',
      messageId: '77',
    })
  })

  it('ignora un toque sin data, que es de un juego', () => {
    expect(
      parseTelegramUpdate({
        update_id: 900_011,
        callback_query: { ...TOQUE.callback_query, data: undefined },
      }),
    ).toBeNull()
  })

  it('ignora un toque sin message, que es de un mensaje inline', () => {
    expect(
      parseTelegramUpdate({
        update_id: 900_012,
        callback_query: {
          ...TOQUE.callback_query,
          message: undefined,
          inline_message_id: 'abc',
        },
      }),
    ).toBeNull()
  })

  it('ignora updates sin mensaje', () => {
    expect(
      parseTelegramUpdate({ update_id: 900_003, callback_query: { id: 'x' } }),
    ).toBeNull()
  })

  it('ignora cuerpos que no tienen forma de update', () => {
    expect(parseTelegramUpdate(null)).toBeNull()
    expect(parseTelegramUpdate({})).toBeNull()
    expect(parseTelegramUpdate('hola')).toBeNull()
  })
})

describe('parseCommand', () => {
  it('reconoce un comando con argumentos', () => {
    expect(parseCommand('/vincular ABC123')).toEqual({
      nombre: 'vincular',
      args: 'ABC123',
    })
  })

  it('reconoce un comando sin argumentos', () => {
    expect(parseCommand('/vincular')).toEqual({ nombre: 'vincular', args: '' })
  })

  it('saca el sufijo @NombreDelBot que agrega Telegram en grupos', () => {
    expect(parseCommand('/vincular@GymTrackerBot ABC123')).toEqual({
      nombre: 'vincular',
      args: 'ABC123',
    })
  })

  it('normaliza el nombre a minúsculas', () => {
    expect(parseCommand('/VINCULAR abc')?.nombre).toBe('vincular')
  })

  it('devuelve null si no es un comando', () => {
    expect(parseCommand('banca 4x10 60')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })
})
