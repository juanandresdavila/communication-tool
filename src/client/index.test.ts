import { describe, expect, it } from 'vitest'
import { createCommToolMessaging } from './index.js'
import { headerDeFirma } from './signature.js'

const BASE_URL = 'https://comm.test'
const API_KEY = 'clave-de-la-app'
const SECRETO = 'secreto-de-entrega'

function fetchQue(estado: number, cuerpo: unknown) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init })
    return new Response(JSON.stringify(cuerpo), { status: estado })
  }
  return { fake: fake as unknown as typeof fetch, llamadas }
}

function crear(fetchImpl: typeof fetch) {
  return createCommToolMessaging({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    deliverySecret: SECRETO,
    fetchFn: fetchImpl,
  })
}

/** Un request de entrega como el que manda comm-tool, bien firmado. */
function entregaFirmada(
  cuerpo: Record<string, unknown>,
  opts: { secreto?: string; t?: number } = {},
): Request {
  const texto = JSON.stringify(cuerpo)
  const t = opts.t ?? Math.floor(Date.now() / 1000)
  return new Request('https://app.test/api/messaging/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Comm-Signature': headerDeFirma(opts.secreto ?? SECRETO, texto, t),
      'X-Comm-Delivery-Id': String(cuerpo['messageId'] ?? 'del-1'),
    },
    body: texto,
  })
}

const ENTREGA = {
  messageId: 'uuid-de-comm-tool',
  userId: 'user-1',
  channel: 'telegram',
  text: 'banca 4x10 60',
  receivedAt: '2026-08-02T12:00:00.000Z',
  raw: { update_id: 900_001 },
}

describe('sendMessage', () => {
  it('postea a /v1/messages con la API key', async () => {
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'uuid',
      providerMessageId: '77',
      status: 'sent',
    })

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'anotado',
      kind: 'reply',
    })

    expect(llamadas[0]?.url).toBe('https://comm.test/v1/messages')
    const headers = new Headers(llamadas[0]?.init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      userId: 'user-1',
      text: 'anotado',
      kind: 'reply',
    })
  })

  it('devuelve el providerMessageId, no el id de comm-tool', async () => {
    // Es LA decisión del cliente. El `messageId` que devuelve `sendMessage` se
    // compara después contra el `replyToMessageId` de un entrante, que viene
    // del proveedor. Devolver el UUID de comm-tool rompería la correlación en
    // silencio: nunca matchearía con nada.
    const { fake } = fetchQue(200, {
      messageId: 'uuid-de-comm-tool',
      providerMessageId: '77',
      status: 'sent',
    })

    expect(
      await crear(fake).sendMessage({
        userId: 'user-1',
        text: 'x',
        kind: 'reply',
      }),
    ).toEqual({ messageId: '77' })
  })

  it('manda replyToMessageId y template solo si vienen', async () => {
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'u',
      providerMessageId: '1',
      status: 'sent',
    })

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'x',
      kind: 'notification',
      replyToMessageId: '55',
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      userId: 'user-1',
      text: 'x',
      kind: 'notification',
      replyToMessageId: '55',
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })
  })

  it('manda la clave de idempotencia cuando viene', async () => {
    // Es lo que hace que un callback de programado reintentado no mande el
    // aviso dos veces: comm-tool deduplica por (app_id, idempotency_key).
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'u',
      providerMessageId: '1',
      status: 'sent',
    })

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'check-in',
      kind: 'notification',
      idempotencyKey: 'sch-1:2026-08-03T01:00:00.000Z',
    })

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      userId: 'user-1',
      text: 'check-in',
      kind: 'notification',
      idempotencyKey: 'sch-1:2026-08-03T01:00:00.000Z',
    })
  })

  it('no manda el campo si no hay clave', async () => {
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'u',
      providerMessageId: '1',
      status: 'sent',
    })

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'x',
      kind: 'reply',
    })

    const cuerpo = JSON.parse(String(llamadas[0]?.init?.body)) as Record<
      string,
      unknown
    >
    expect('idempotencyKey' in cuerpo).toBe(false)
  })

  it('tira si el usuario no está vinculado', async () => {
    // Mismo comportamiento que el adapter de Telegram directo, que tira
    // "no tiene chat de Telegram vinculado". La suite de conformidad lo exige.
    const { fake } = fetchQue(404, { code: 'not_linked' })
    await expect(
      crear(fake).sendMessage({ userId: 'user-9', text: 'x', kind: 'reply' }),
    ).rejects.toThrow(/not_linked/)
  })

  it('tira si comm-tool devuelve un error del proveedor', async () => {
    const { fake } = fetchQue(502, {
      code: 'send_failed',
      error: 'chat not found',
    })
    await expect(
      crear(fake).sendMessage({ userId: 'user-1', text: 'x', kind: 'reply' }),
    ).rejects.toThrow(/send_failed/)
  })

  it('nunca incluye la API key en el mensaje de error', async () => {
    const { fake } = fetchQue(500, { code: 'boom' })
    await expect(
      crear(fake).sendMessage({ userId: 'user-1', text: 'x', kind: 'reply' }),
    ).rejects.toThrow(/^(?!.*clave-de-la-app).*$/s)
  })
})

describe('parseIncoming', () => {
  const sinRed = (async () => {
    throw new Error('parseIncoming no debería llamar a la red')
  }) as unknown as typeof fetch

  it('devuelve el mensaje cuando la firma es válida', async () => {
    const res = await crear(sinRed).parseIncoming(entregaFirmada(ENTREGA))

    expect(res).toEqual({
      userId: 'user-1',
      text: 'banca 4x10 60',
      channel: 'telegram',
      messageId: 'uuid-de-comm-tool',
      receivedAt: '2026-08-02T12:00:00.000Z',
      raw: { update_id: 900_001 },
    })
  })

  it('devuelve null si la firma es de otro secreto', async () => {
    const req = entregaFirmada(ENTREGA, { secreto: 'otro' })
    expect(await crear(sinRed).parseIncoming(req)).toBeNull()
  })

  it('devuelve null si falta el header de firma', async () => {
    const req = new Request('https://app.test/x', {
      method: 'POST',
      body: JSON.stringify(ENTREGA),
    })
    expect(await crear(sinRed).parseIncoming(req)).toBeNull()
  })

  it('devuelve null si la firma venció la ventana anti-replay', async () => {
    const viejo = Math.floor(Date.now() / 1000) - 400
    expect(
      await crear(sinRed).parseIncoming(entregaFirmada(ENTREGA, { t: viejo })),
    ).toBeNull()
  })

  it('un entrante sin texto llega con text vacío, NO con null', async () => {
    // Es la diferencia que el spec marca explícitamente: una foto no se
    // descarta, se entrega con text "" y decide la app.
    const res = await crear(sinRed).parseIncoming(
      entregaFirmada({ ...ENTREGA, text: '' }),
    )
    expect(res?.text).toBe('')
    expect(res).not.toBeNull()
  })

  it('propaga replyToMessageId cuando viene', async () => {
    const res = await crear(sinRed).parseIncoming(
      entregaFirmada({ ...ENTREGA, replyToMessageId: '55' }),
    )
    expect(res?.replyToMessageId).toBe('55')
  })

  it('devuelve null ante un cuerpo que no es una entrega', async () => {
    const req = entregaFirmada({ cualquiera: 'cosa' })
    expect(await crear(sinRed).parseIncoming(req)).toBeNull()
  })
})
