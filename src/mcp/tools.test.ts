import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact } from '../db/ports.js'
import type { SendDeps } from '../outbound/send.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { ejecutarTool, TOOLS } from './tools.js'

describe('TOOLS', () => {
  it('expone las dos tools de salida, en orden determinista', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['enviar_mensaje', 'ver_contacto'])
  })

  it('no expone ninguna tool de programados', () => {
    // El scheduler dispara contra un schedule_callback_url HTTP que un cliente
    // MCP no tiene: un programado creado desde acá se marcaría failed sin
    // postear a nadie.
    const nombres = TOOLS.map((t) => t.name).join(' ')
    expect(nombres).not.toContain('programar')
  })

  it('declara el limite de Telegram en el schema, para que el modelo parta el texto', () => {
    const enviar = TOOLS.find((t) => t.name === 'enviar_mensaje')
    expect(enviar?.inputSchema.properties.text).toMatchObject({ maxLength: 4096 })
    expect(enviar?.inputSchema.required).toEqual(['userId', 'text'])
  })

  it('cada tool tiene descripcion y un inputSchema de tipo object', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })
})

const APP_ID = 'app-1'

function armarDeps(
  opts: { contactos?: Contact[]; bots?: Bot[]; falla?: boolean } = {},
): SendDeps {
  const telegram: TelegramClient = {
    async sendMessage() {
      if (opts.falla) throw new Error('Telegram rechazó sendMessage: chat not found')
      return { messageId: 'tg-1' }
    },
  }

  return {
    bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
    contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
    outbound: createFakeOutboundMessagesRepo([]),
    telegram,
    secrets: () => 'token',
  }
}

describe('ejecutarTool: enviar_mensaje', () => {
  it('manda y devuelve el id del proveedor', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'enviar_mensaje', {
      userId: 'user-1',
      text: 'pendientes de hoy',
    })

    expect(r).toEqual({ tipo: 'ok', texto: expect.stringContaining('tg-1') })
  })

  it('un usuario no vinculado es error de ejecucion, no de protocolo', async () => {
    const r = await ejecutarTool(armarDeps({ contactos: [] }), APP_ID, 'enviar_mensaje', {
      userId: 'fantasma',
      text: 'hola',
    })

    expect(r.tipo).toBe('error_de_ejecucion')
  })

  it('un rechazo de Telegram es error de ejecucion y dice la causa', async () => {
    const r = await ejecutarTool(armarDeps({ falla: true }), APP_ID, 'enviar_mensaje', {
      userId: 'user-1',
      text: 'hola',
    })

    expect(r).toEqual({
      tipo: 'error_de_ejecucion',
      texto: expect.stringContaining('chat not found'),
    })
  })

  it('rechaza un texto mas largo que el limite de Telegram', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'enviar_mensaje', {
      userId: 'user-1',
      text: 'x'.repeat(4097),
    })

    expect(r.tipo).toBe('argumentos_invalidos')
  })

  it('rechaza argumentos que no cumplen el schema', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'enviar_mensaje', { text: 'hola' })

    expect(r.tipo).toBe('argumentos_invalidos')
  })
})

describe('ejecutarTool: ver_contacto', () => {
  it('dice que esta vinculado sin filtrar el chat id', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'ver_contacto', {
      userId: 'user-1',
    })

    expect(r).toMatchObject({ tipo: 'ok' })
    // El externalId del contacto de prueba es '12345'. La app nunca ve el
    // chat id: es el invariante central del servicio.
    expect(r.tipo === 'ok' && r.texto).not.toContain('12345')
  })

  it('dice que no esta vinculado cuando no hay contacto', async () => {
    const r = await ejecutarTool(armarDeps({ contactos: [] }), APP_ID, 'ver_contacto', {
      userId: 'user-1',
    })

    expect(r).toMatchObject({ tipo: 'ok', texto: expect.stringContaining('no está') })
  })
})

describe('ejecutarTool: tool desconocida', () => {
  it('la reporta como tal', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'borrar_todo', {})

    expect(r).toEqual({ tipo: 'tool_desconocida' })
  })
})
