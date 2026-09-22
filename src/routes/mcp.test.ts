import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import { createApp } from '../create-app.js'
import type { Contact } from '../db/ports.js'
import { hashApiKey } from '../identity/api-key.js'
import { VERSION_ACTUAL } from '../mcp/protocol.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { createFakeDeps } from '../test-support/fake-deps.js'
import {
  createFakeAppsRepo,
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unApp,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { telegramFalso } from '../test-support/fake-telegram.js'
import { mcpRoutes } from './mcp.js'

function armar(opts: { contactos?: Contact[] } = {}) {
  const telegram: TelegramClient = {
    ...telegramFalso(),
    async sendMessage() {
      return { messageId: 'tg-1' }
    },
  }

  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route(
    '/',
    mcpRoutes({
      bots: createFakeBotsRepo([unBot()]),
      contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
      outbound: createFakeOutboundMessagesRepo([]),
      telegram,
      secrets: () => 'token',
    }),
  )
  return server
}

function postear(
  server: Hono<ConVariablesDeApp>,
  cuerpo: unknown,
  headers: Record<string, string> = {},
) {
  return server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(cuerpo),
  })
}

const META = {
  'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
  'io.modelcontextprotocol/clientCapabilities': {},
}

describe('POST /mcp: era legacy', () => {
  it('contesta initialize con sus capacidades', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'communication-tool' },
      },
    })
  })

  it('acepta notifications/initialized con 202 y sin cuerpo', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('lista las tools sin exigir headers', async () => {
    const res = await postear(armar(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const cuerpo = (await res.json()) as {
      result: { tools: { name: string }[] }
    }

    expect(res.status).toBe(200)
    expect(cuerpo.result.tools.map((t) => t.name)).toEqual([
      'enviar_mensaje',
      'ver_contacto',
    ])
  })
})

describe('POST /mcp: era moderna', () => {
  it('contesta server/discover con las versiones soportadas', async () => {
    const res = await postear(
      armar(),
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } },
      { 'MCP-Protocol-Version': VERSION_ACTUAL, 'Mcp-Method': 'server/discover' },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      result: {
        resultType: 'complete',
        supportedVersions: [VERSION_ACTUAL, '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
      },
    })
  })

  it('manda un mensaje por tools/call', async () => {
    const res = await postear(
      armar(),
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'enviar_mensaje',
          arguments: { userId: 'user-1', text: 'pendientes de hoy' },
          _meta: META,
        },
      },
      {
        'MCP-Protocol-Version': VERSION_ACTUAL,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'enviar_mensaje',
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      result: { resultType: 'complete', isError: false },
    })
  })

  it('un usuario no vinculado vuelve como isError, con 200', async () => {
    const res = await postear(
      armar({ contactos: [] }),
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'enviar_mensaje',
          arguments: { userId: 'fantasma', text: 'hola' },
          _meta: META,
        },
      },
      {
        'MCP-Protocol-Version': VERSION_ACTUAL,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'enviar_mensaje',
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { isError: true } })
  })

  it('un header que no coincide con el cuerpo es 400 con -32020', async () => {
    const res = await postear(
      armar(),
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: META } },
      { 'MCP-Protocol-Version': VERSION_ACTUAL, 'Mcp-Method': 'tools/call' },
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32020 } })
  })

  it('una version desconocida es 400 con -32022', async () => {
    const res = await postear(
      armar(),
      { jsonrpc: '2.0', id: 6, method: 'tools/list' },
      { 'MCP-Protocol-Version': '2030-01-01', 'Mcp-Method': 'tools/list' },
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32022 } })
  })
})

describe('POST /mcp: metodos y verbos', () => {
  it('un metodo desconocido es 404 con -32601', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: -32601 } })
  })

  it('una tool desconocida es 400 con -32602', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'borrar_todo', arguments: {} },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32602 } })
  })

  it('GET y DELETE devuelven 405: esta revision no tiene stream ni sesiones', async () => {
    expect((await armar().request('/mcp')).status).toBe(405)
    expect((await armar().request('/mcp', { method: 'DELETE' })).status).toBe(405)
  })
})

const CLAVE = 'ct_clave_de_spark'

function armarAppEntera() {
  // createFakeDeps recibe un objeto de overrides, no un spread: su firma es
  // createFakeDeps(over: Partial<Deps> = {}).
  return createApp(
    createFakeDeps({
      apps: createFakeAppsRepo([{ hash: hashApiKey(CLAVE), app: unApp() }]),
      contacts: createFakeContactsRepo([unContacto()]),
      bots: createFakeBotsRepo([unBot()]),
    }),
  )
}

describe('/mcp montado en la app', () => {
  it('sin API key no pasa', async () => {
    const res = await armarAppEntera().request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(401)
  })

  it('con API key lista las tools', async () => {
    const res = await armarAppEntera().request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLAVE}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(200)
  })

  it('un request con header Origin no pasa, ni siquiera con API key', async () => {
    const res = await armarAppEntera().request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLAVE}`,
        Origin: 'https://sitio-cualquiera.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(403)
  })

  it('una URL inexistente sigue siendo 404, no 401', async () => {
    // El middleware va montado en '/mcp' y no en '*' justamente por esto.
    const res = await armarAppEntera().request('/no-existe')

    expect(res.status).toBe(404)
  })
})
