import { describe, expect, it } from 'vitest'
import type { ContextoDeConformidad } from './conformance.js'
import { CASOS_DE_CONFORMIDAD } from './conformance.js'
import { createCommToolMessaging } from './index.js'
import { headerDeFirma } from './signature.js'

const BASE_URL = 'https://comm.test'
const SECRETO = 'secreto-de-entrega'
const VINCULADO = 'user-1'
const SIN_VINCULAR = 'user-9'

function entrega(over: Record<string, unknown> = {}): Request {
  const cuerpo = JSON.stringify({
    messageId: 'uuid-de-comm-tool',
    userId: VINCULADO,
    channel: 'telegram',
    text: 'banca 4x10 60',
    receivedAt: '2026-08-02T12:00:00.000Z',
    raw: { update_id: 900_001, message: { chat: { id: 12_345 } } },
    ...over,
  })
  const t = Math.floor(Date.now() / 1000)
  return new Request('https://app.test/api/messaging/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Comm-Signature': headerDeFirma(SECRETO, cuerpo, t),
    },
    body: cuerpo,
  })
}

const fetchFalso = (async (_url: string, init?: RequestInit) => {
  const enviado = JSON.parse(String(init?.body)) as { userId: string }
  if (enviado.userId === SIN_VINCULAR) {
    return new Response(JSON.stringify({ code: 'not_linked' }), { status: 404 })
  }
  return new Response(
    JSON.stringify({
      messageId: 'uuid',
      providerMessageId: '77',
      status: 'sent',
    }),
    { status: 200 },
  )
}) as unknown as typeof fetch

const contexto: ContextoDeConformidad = {
  messaging: createCommToolMessaging({
    baseUrl: BASE_URL,
    apiKey: 'clave',
    deliverySecret: SECRETO,
    fetchFn: fetchFalso,
  }),
  requestValido: () => entrega(),
  requestInvalido: () =>
    new Request('https://app.test/api/messaging/inbound', {
      method: 'POST',
      headers: { 'X-Comm-Signature': 't=1,v1=falsa' },
      body: JSON.stringify({ messageId: 'x' }),
    }),
  requestSinTexto: () => entrega({ text: '' }),
  esperado: {
    userId: VINCULADO,
    text: 'banca 4x10 60',
    messageId: 'uuid-de-comm-tool',
  },
  userIdVinculado: VINCULADO,
  userIdSinVincular: SIN_VINCULAR,
}

describe('conformidad — implementación de comm-tool', () => {
  it('la suite no está vacía', () => {
    // Un enganche que itera una lista vacía pasa en verde y no prueba nada.
    expect(CASOS_DE_CONFORMIDAD.length).toBeGreaterThan(5)
  })

  for (const caso of CASOS_DE_CONFORMIDAD) {
    it(caso.nombre, async () => {
      await caso.ejecutar(contexto)
    })
  }
})
