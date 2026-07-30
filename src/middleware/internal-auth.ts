import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export function internalAuth(secreto: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const [esquema, valor] = header.split(' ')

    if (esquema !== 'Bearer' || !valor) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    // Comparación de dos secretos: acá sí hace falta timing-safe, a
    // diferencia de la API key, que se busca por hash en la base.
    const a = Buffer.from(valor, 'utf8')
    const b = Buffer.from(secreto, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    await next()
    return undefined
  }
}
