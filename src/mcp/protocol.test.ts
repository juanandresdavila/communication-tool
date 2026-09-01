import { describe, expect, it } from 'vitest'
import { analizarPedido, CODIGO, VERSION_ACTUAL } from './protocol.js'

const SIN_HEADERS = { protocolVersion: null, method: null, name: null }

describe('analizarPedido: sobre JSON-RPC', () => {
  it('acepta un pedido legacy sin headers', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      SIN_HEADERS,
    )

    expect(r).toEqual({
      tipo: 'pedido',
      id: 1,
      method: 'tools/list',
      params: {},
      version: null,
      moderna: false,
    })
  })

  it('un cuerpo que no es objeto es un parse error', () => {
    const r = analizarPedido('no soy json-rpc', SIN_HEADERS)

    expect(r).toEqual({
      tipo: 'falla',
      estado: 400,
      id: null,
      code: CODIGO.parseError,
      message: expect.stringContaining('objeto JSON-RPC'),
    })
  })

  it('rechaza un sobre sin jsonrpc 2.0', () => {
    const r = analizarPedido({ id: 1, method: 'tools/list' }, SIN_HEADERS)

    expect(r).toMatchObject({ tipo: 'falla', code: CODIGO.invalidRequest })
  })

  it('rechaza un sobre sin método', () => {
    const r = analizarPedido({ jsonrpc: '2.0', id: 1 }, SIN_HEADERS)

    expect(r).toMatchObject({ tipo: 'falla', code: CODIGO.invalidRequest })
  })

  it('un sobre sin id es una notificación', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      SIN_HEADERS,
    )

    expect(r).toEqual({ tipo: 'notificacion' })
  })

  it('expone params y reconoce la era moderna por el header', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 'a',
        method: 'tools/list',
        params: {
          cursor: 'x',
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      { protocolVersion: VERSION_ACTUAL, method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({ tipo: 'pedido', moderna: true, version: VERSION_ACTUAL })
  })
})
