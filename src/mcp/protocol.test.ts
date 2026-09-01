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

describe('analizarPedido: versión del protocolo', () => {
  it('toma la versión del cuerpo cuando no viene el header', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      SIN_HEADERS,
    )

    expect(r).toMatchObject({ tipo: 'pedido', version: VERSION_ACTUAL, moderna: true })
  })

  it('rechaza header y cuerpo que dicen versiones distintas', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
        },
      },
      { protocolVersion: VERSION_ACTUAL, method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({
      tipo: 'falla',
      estado: 400,
      id: 1,
      code: CODIGO.headerMismatch,
    })
  })

  it('rechaza una versión que no soportamos y lista las que sí', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { protocolVersion: '2030-01-01', method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({
      tipo: 'falla',
      estado: 400,
      code: CODIGO.unsupportedVersion,
      data: { supported: [VERSION_ACTUAL, '2025-11-25', '2025-06-18'] },
    })
  })

  it('acepta una versión legacy conocida sin exigirle nada moderno', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { protocolVersion: '2025-11-25', method: null, name: null },
    )

    expect(r).toMatchObject({ tipo: 'pedido', moderna: false })
  })
})

const META_MODERNA = {
  'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
  'io.modelcontextprotocol/clientCapabilities': {},
}

function moderno(
  method: string,
  params: Record<string, unknown> = {},
  headers: Partial<{ method: string | null; name: string | null }> = {},
) {
  return analizarPedido(
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META_MODERNA } },
    {
      protocolVersion: VERSION_ACTUAL,
      method: headers.method === undefined ? method : headers.method,
      name: headers.name ?? null,
    },
  )
}

describe('analizarPedido: headers de la era moderna', () => {
  it('exige el header Mcp-Method', () => {
    expect(moderno('tools/list', {}, { method: null })).toMatchObject({
      tipo: 'falla',
      code: CODIGO.headerMismatch,
      message: expect.stringContaining('Mcp-Method'),
    })
  })

  it('rechaza un Mcp-Method que no coincide con el cuerpo', () => {
    expect(moderno('tools/list', {}, { method: 'tools/call' })).toMatchObject({
      tipo: 'falla',
      code: CODIGO.headerMismatch,
    })
  })

  it('exige el header Mcp-Name en tools/call', () => {
    expect(moderno('tools/call', { name: 'ver_contacto' })).toMatchObject({
      tipo: 'falla',
      code: CODIGO.headerMismatch,
      message: expect.stringContaining('Mcp-Name'),
    })
  })

  it('acepta un tools/call con los dos headers correctos', () => {
    expect(
      moderno('tools/call', { name: 'ver_contacto' }, { name: 'ver_contacto' }),
    ).toMatchObject({ tipo: 'pedido', moderna: true })
  })

  it('decodifica el sentinela base64 del Mcp-Name antes de comparar', () => {
    expect(
      moderno(
        'tools/call',
        { name: 'ver_contacto' },
        { name: '=?base64?dmVyX2NvbnRhY3Rv?=' },
      ),
    ).toMatchObject({ tipo: 'pedido' })
  })

  it('exige clientCapabilities en el _meta', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL },
        },
      },
      { protocolVersion: VERSION_ACTUAL, method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({ tipo: 'falla', code: CODIGO.invalidParams })
  })

  it('no le exige headers a un cliente legacy', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
      { protocolVersion: '2025-11-25', method: null, name: null },
    )

    expect(r).toMatchObject({ tipo: 'pedido', moderna: false })
  })
})
