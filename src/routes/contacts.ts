import { Hono } from 'hono'
import type { ContactsRepo } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'

export interface ContactDeps {
  contacts: ContactsRepo
}

export function contactRoutes(deps: ContactDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.get('/v1/contacts/:userId', async (c) => {
    const app = c.get('app')
    const contacto = await deps.contacts.findByAppUserId(
      app.id,
      'telegram',
      c.req.param('userId'),
    )

    if (!contacto) return c.json({ linked: false })

    // Nunca se devuelve externalId: la app no conoce el chat_id.
    return c.json({
      linked: true,
      channel: contacto.channel,
      linkedAt: contacto.linkedAt,
    })
  })

  rutas.delete('/v1/contacts/:userId', async (c) => {
    const app = c.get('app')
    const borrado = await deps.contacts.deleteByAppUserId(
      app.id,
      'telegram',
      c.req.param('userId'),
    )
    return c.json({ unlinked: borrado })
  })

  return rutas
}
