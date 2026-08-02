import { firmaValida } from '../src/client/signature.js'

const SECRETO = process.env.DELIVERY_SECRET_GYM ?? ''
if (!SECRETO) throw new Error('falta DELIVERY_SECRET_GYM')

const vistos = new Set<string>()

export default {
  port: 4321,
  async fetch(req: Request): Promise<Response> {
    const cuerpo = await req.text()
    const firma = req.headers.get('X-Comm-Signature') ?? ''
    const deliveryId = req.headers.get('X-Comm-Delivery-Id') ?? ''

    if (!firmaValida(SECRETO, cuerpo, firma, Date.now())) {
      console.log('FIRMA INVÁLIDA — rechazado')
      return new Response('firma inválida', { status: 401 })
    }

    if (vistos.has(deliveryId)) {
      console.log(`duplicado ${deliveryId} — deduplicado, no se procesa`)
      return new Response('ok', { status: 200 })
    }
    vistos.add(deliveryId)

    console.log(`ENTREGA OK ${deliveryId}:`, cuerpo)
    return new Response('ok', { status: 200 })
  },
}
