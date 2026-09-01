import { type Context, Hono, type MiddlewareHandler } from 'hono'
import {
  analizarPedido,
  CODIGO,
  SERVER_INFO,
  VERSIONES_SOPORTADAS,
} from '../mcp/protocol.js'
import { ejecutarTool, TOOLS } from '../mcp/tools.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import type { SendDeps } from '../outbound/send.js'

/**
 * El spec de MCP obliga a validar Origin contra DNS rebinding. Acá ningún
 * cliente legítimo es un navegador y la API key es un bearer que no debe ser
 * alcanzable desde una página, así que la regla es la más estricta posible:
 * si viene Origin, no pasa. No necesita configuración.
 */
export function sinOrigen(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header('Origin') !== undefined) {
      return c.json({ code: 'forbidden' }, 403)
    }
    await next()
    return undefined
  }
}

function resultado(id: string | number, result: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, result }
}

function errorJsonRpc(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

/** El `initialize` de la era vieja espera que se le repita una versión que las
 *  dos partes hablen. */
function versionEco(params: Record<string, unknown>): string {
  const pedida = params.protocolVersion
  if (typeof pedida === 'string' && VERSIONES_SOPORTADAS.includes(pedida)) {
    return pedida
  }
  return '2025-11-25'
}

export function mcpRoutes(deps: SendDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  // La revisión 2026-07-28 sacó el stream GET y las sesiones, así que el
  // endpoint es un solo POST. Contestar 405 es lo que el spec pide para un
  // cliente viejo que intente abrir un stream.
  rutas.on(['GET', 'DELETE'], '/mcp', (c) => c.text('Method Not Allowed', 405))

  rutas.post('/mcp', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const analisis = analizarPedido(crudo, {
      protocolVersion: c.req.header('MCP-Protocol-Version') ?? null,
      method: c.req.header('Mcp-Method') ?? null,
      name: c.req.header('Mcp-Name') ?? null,
    })

    if (analisis.tipo === 'notificacion') return c.body(null, 202)

    if (analisis.tipo === 'falla') {
      return c.json(
        errorJsonRpc(analisis.id, analisis.code, analisis.message, analisis.data),
        analisis.estado,
      )
    }

    const { id, method, params } = analisis

    switch (method) {
      case 'server/discover':
        return c.json(
          resultado(id, {
            resultType: 'complete',
            supportedVersions: [...VERSIONES_SOPORTADAS],
            capabilities: { tools: {} },
            instructions:
              'Manda mensajes de Telegram al usuario de esta app. Solo transporta: no lee ni interpreta contenido, y no recibe respuestas.',
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          }),
        )

      case 'initialize':
        return c.json(
          resultado(id, {
            resultType: 'complete',
            protocolVersion: versionEco(params),
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }),
        )

      case 'tools/list':
        return c.json(resultado(id, { resultType: 'complete', tools: [...TOOLS] }))

      case 'tools/call':
        return await llamarTool(c, deps, id, params)

      default:
        return c.json(
          errorJsonRpc(id, CODIGO.methodNotFound, `Método desconocido: ${method}`),
          404,
        )
    }
  })

  return rutas
}

/** Va aparte del switch para que cada rama devuelva una Response y el handler
 *  no tenga un camino que caiga al final sin contestar. */
async function llamarTool(
  c: Context<ConVariablesDeApp>,
  deps: SendDeps,
  id: string | number,
  params: Record<string, unknown>,
): Promise<Response> {
  const nombre = typeof params.name === 'string' ? params.name : ''
  const argumentos =
    typeof params.arguments === 'object' && params.arguments !== null
      ? params.arguments
      : {}

  const r = await ejecutarTool(deps, c.get('app').id, nombre, argumentos)

  switch (r.tipo) {
    case 'ok':
    case 'error_de_ejecucion':
      return c.json(
        resultado(id, {
          resultType: 'complete',
          content: [{ type: 'text', text: r.texto }],
          isError: r.tipo === 'error_de_ejecucion',
        }),
      )
    case 'tool_desconocida':
      return c.json(
        errorJsonRpc(id, CODIGO.invalidParams, `Tool desconocida: ${nombre}`),
        400,
      )
    case 'argumentos_invalidos':
      return c.json(errorJsonRpc(id, CODIGO.invalidParams, r.detalle), 400)
  }
}
