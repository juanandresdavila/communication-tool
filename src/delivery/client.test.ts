import { describe, expect, it } from 'vitest'
import { createDeliveryClient } from './client.js'

function fetchQue(respuesta: () => Promise<Response>) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init })
    return respuesta()
  }
  return { fake, llamadas }
}

const ok = () => Promise.resolve(new Response('', { status: 200 }))

describe('createDeliveryClient', () => {
  it('postea el cuerpo con los headers de firma e idempotencia', async () => {
    const { fake, llamadas } = fetchQue(ok)
    const cliente = createDeliveryClient(fake)

    const res = await cliente.entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{"a":1}',
      firma: 't=1,v1=abc',
      deliveryId: 'del-1',
      timeoutMs: 5000,
    })

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(llamadas[0]?.url).toBe('https://app.test/inbound')

    const headers = new Headers(llamadas[0]?.init?.headers)
    expect(headers.get('X-Comm-Signature')).toBe('t=1,v1=abc')
    expect(headers.get('X-Comm-Delivery-Id')).toBe('del-1')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(llamadas[0]?.init?.body).toBe('{"a":1}')
  })

  it('acepta cualquier 2xx', async () => {
    // El cuerpo va en null y no en '': un 204 es null-body status y el
    // constructor de undici (el que corre bajo Vitest) rechaza cualquier
    // cuerpo, aunque sea vacío. Bun lo tolera y taparía el error.
    const { fake } = fetchQue(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    const res = await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(true)
  })

  it('trata un 500 como fallo y describe el estado', async () => {
    const { fake } = fetchQue(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    )
    const res = await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/500/)
  })

  it('trata un error de red como fallo, sin propagar la excepción', async () => {
    const { fake } = fetchQue(() => Promise.reject(new Error('ECONNREFUSED')))
    const res = await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ECONNREFUSED/)
  })

  it('pasa una señal de abort para el timeout', async () => {
    const { fake, llamadas } = fetchQue(ok)
    await createDeliveryClient(fake).entregar({
      url: 'https://app.test/inbound',
      cuerpo: '{}',
      firma: 't=1,v1=a',
      deliveryId: 'd',
      timeoutMs: 5000,
    })
    expect(llamadas[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })
})
