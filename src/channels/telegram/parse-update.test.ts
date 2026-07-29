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
    expect(parseTelegramUpdate(conRespuesta)?.replyToMessageId).toBe('7')
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
