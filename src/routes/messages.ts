import { Hono } from 'hono'
import * as z from 'zod'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import type { SendDeps } from '../outbound/send.js'
import { enviarSaliente } from '../outbound/send.js'

/**
 * Telegram corta los mensajes de texto en 4096 caracteres. Validarlo acá
 * convierte un 502 del proveedor en un 400 con causa clara.
 */
const LARGO_MAXIMO_TEXTO = 4096

const cuerpoSchema = z.object({
  userId: z.string().min(1),
  text: z.string().min(1).max(LARGO_MAXIMO_TEXTO),
  kind: z.enum(['reply', 'notification']),
  replyToMessageId: z.string().min(1).optional(),
  template: z
    .object({
      name: z.string().min(1),
      vars: z.record(z.string(), z.string()),
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

export function messageRoutes(deps: SendDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.post('/v1/messages', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = cuerpoSchema.safeParse(crudo)
    if (!parseado.success) {
      return c.json({ code: 'invalid_request' }, 400)
    }

    const app = c.get('app')
    const resultado = await enviarSaliente(deps, app.id, {
      userId: parseado.data.userId,
      text: parseado.data.text,
      kind: parseado.data.kind,
      replyToMessageId: parseado.data.replyToMessageId ?? null,
      template: parseado.data.template ?? null,
      idempotencyKey: parseado.data.idempotencyKey ?? null,
    })

    switch (resultado.estado) {
      // Un duplicado contesta lo mismo que el original, con el mismo código:
      // para la app, reintentar tiene que ser indistinguible de acertar a la
      // primera.
      case 'sent':
      case 'duplicate':
        return c.json({
          messageId: resultado.mensaje.id,
          providerMessageId: resultado.providerMessageId,
          status: 'sent',
        })
      case 'not_linked':
        return c.json({ code: 'not_linked' }, 404)
      case 'in_progress':
        // La reserva anterior nunca se cerró. No se puede saber si el mensaje
        // salió, así que se avisa en vez de arriesgar un duplicado.
        return c.json({ code: 'in_progress' }, 409)
      case 'no_bot':
        return c.json({ code: 'no_bot' }, 500)
      case 'send_failed':
        return c.json(
          {
            code: 'send_failed',
            messageId: resultado.mensaje.id,
            error: resultado.error,
          },
          502,
        )
    }
  })

  return rutas
}
