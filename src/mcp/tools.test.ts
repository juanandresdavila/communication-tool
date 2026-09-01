import { describe, expect, it } from 'vitest'
import { TOOLS } from './tools.js'

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
