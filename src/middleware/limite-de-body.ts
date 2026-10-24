import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/** Tope del body de cualquier pedido autenticado de /v1 y /mcp: 256 KiB. */
export const LIMITE_BODY_BYTES = 256 * 1024

/**
 * Va DESPUÉS de la auth: un body enorme sin clave da 401, no 413. El `onError`
 * de por defecto de Hono tira un HTTPException con texto plano, y las apps
 * esperan el `{ code }` de siempre.
 */
export function limiteDeBody(): MiddlewareHandler {
  return bodyLimit({
    maxSize: LIMITE_BODY_BYTES,
    onError: (c) => c.json({ code: 'payload_too_large' }, 413),
  })
}
