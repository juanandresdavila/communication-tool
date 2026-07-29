import { Hono } from 'hono'
import * as z from 'zod'
import type { LinkCodesRepo } from '../db/ports.js'
import { generateLinkCode, LARGO_CODIGO } from '../identity/link-code.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'

const TTL_POR_DEFECTO = 15 * 60
const TTL_MAXIMO = 24 * 60 * 60

/**
 * Se piden más bytes que caracteres porque el generador descarta los que
 * introducirían sesgo de módulo. Con 16 bytes la probabilidad de quedarse
 * corto es despreciable.
 */
const BYTES_A_PEDIR = 16

const cuerpoSchema = z.object({
  userId: z.string().min(1),
  ttlSeconds: z.number().int().min(1).max(TTL_MAXIMO).optional(),
})

export interface LinkCodeDeps {
  linkCodes: LinkCodesRepo
  now: () => Date
  randomBytes: (n: number) => Uint8Array
}

export function linkCodeRoutes(deps: LinkCodeDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.post('/v1/link-codes', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = cuerpoSchema.safeParse(crudo)
    if (!parseado.success) {
      return c.json({ code: 'invalid_request' }, 400)
    }

    const app = c.get('app')
    const ttl = parseado.data.ttlSeconds ?? TTL_POR_DEFECTO
    const expiresAt = new Date(deps.now().getTime() + ttl * 1000)
    const code = generateLinkCode(deps.randomBytes(BYTES_A_PEDIR))

    await deps.linkCodes.create({
      code,
      appId: app.id,
      appUserId: parseado.data.userId,
      expiresAt,
    })

    return c.json(
      { code, expiresAt: expiresAt.toISOString(), length: LARGO_CODIGO },
      201,
    )
  })

  return rutas
}
