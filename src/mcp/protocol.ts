/**
 * Revisión actual del protocolo MCP. Trae metadata por request y
 * `server/discover`; las anteriores usan el handshake `initialize`. Se
 * contestan las dos eras porque no se sabe cuál habla el cliente y no se lo
 * puede averiguar hasta tenerlo conectado.
 */
export const VERSION_ACTUAL = '2026-07-28'

export const VERSIONES_SOPORTADAS: readonly string[] = [
  VERSION_ACTUAL,
  '2025-11-25',
  '2025-06-18',
]

export const SERVER_INFO = {
  name: 'communication-tool',
  version: '0.1.0',
} as const

export const CODIGO = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const

const CLAVE_VERSION = 'io.modelcontextprotocol/protocolVersion'

export interface HeadersMcp {
  protocolVersion: string | null
  method: string | null
  name: string | null
}

export type Analisis =
  | { tipo: 'notificacion' }
  | {
      tipo: 'pedido'
      id: string | number
      method: string
      params: Record<string, unknown>
      version: string | null
      moderna: boolean
    }
  | {
      tipo: 'falla'
      estado: 400 | 404
      id: string | number | null
      code: number
      message: string
      data?: unknown
    }

function falla(
  estado: 400 | 404,
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Analisis {
  return data === undefined
    ? { tipo: 'falla', estado, id, code, message }
    : { tipo: 'falla', estado, id, code, message, data }
}

function objeto(valor: unknown): Record<string, unknown> | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return null
  }
  return valor as Record<string, unknown>
}

export function analizarPedido(crudo: unknown, headers: HeadersMcp): Analisis {
  const sobre = objeto(crudo)
  if (!sobre) {
    return falla(
      400,
      null,
      CODIGO.parseError,
      'El cuerpo no es un objeto JSON-RPC.',
    )
  }
  if (sobre.jsonrpc !== '2.0') {
    return falla(400, null, CODIGO.invalidRequest, 'Falta jsonrpc: "2.0".')
  }
  if (typeof sobre.method !== 'string') {
    return falla(400, null, CODIGO.invalidRequest, 'Falta el método.')
  }

  // Sin id es una notificación: se acepta y no se contesta nada.
  if (sobre.id === undefined || sobre.id === null) return { tipo: 'notificacion' }
  if (typeof sobre.id !== 'string' && typeof sobre.id !== 'number') {
    return falla(
      400,
      null,
      CODIGO.invalidRequest,
      'El id tiene que ser string o número.',
    )
  }
  const id = sobre.id
  const params = objeto(sobre.params) ?? {}
  const meta = objeto(params._meta) ?? {}
  const versionCuerpo =
    typeof meta[CLAVE_VERSION] === 'string' ? meta[CLAVE_VERSION] : null

  // El header y el cuerpo tienen que decir lo mismo. Si un intermediario
  // rutea por el header y el servidor ejecuta por el cuerpo, que discrepen es
  // un agujero, no una molestia.
  if (
    headers.protocolVersion !== null &&
    versionCuerpo !== null &&
    headers.protocolVersion !== versionCuerpo
  ) {
    return falla(
      400,
      id,
      CODIGO.headerMismatch,
      `MCP-Protocol-Version "${headers.protocolVersion}" no coincide con el cuerpo "${versionCuerpo}".`,
    )
  }

  const version = headers.protocolVersion ?? versionCuerpo
  if (version !== null && !VERSIONES_SOPORTADAS.includes(version)) {
    return falla(
      400,
      id,
      CODIGO.unsupportedVersion,
      `Versión de protocolo no soportada: ${version}.`,
      { supported: [...VERSIONES_SOPORTADAS] },
    )
  }

  return {
    tipo: 'pedido',
    id,
    method: sobre.method,
    params,
    version,
    moderna: version === VERSION_ACTUAL,
  }
}
