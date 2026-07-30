import type { Fetch } from '../channels/telegram/client.js'

export interface EntregaPedido {
  url: string
  cuerpo: string
  firma: string
  deliveryId: string
  timeoutMs: number
}

export interface EntregaResultado {
  ok: boolean
  status: number
  error?: string
}

export interface DeliveryClient {
  entregar(pedido: EntregaPedido): Promise<EntregaResultado>
}

export function createDeliveryClient(fetchImpl: Fetch = fetch): DeliveryClient {
  return {
    async entregar(pedido) {
      try {
        const res = await fetchImpl(pedido.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Comm-Signature': pedido.firma,
            'X-Comm-Delivery-Id': pedido.deliveryId,
          },
          body: pedido.cuerpo,
          signal: AbortSignal.timeout(pedido.timeoutMs),
        })

        if (res.ok) return { ok: true, status: res.status }
        return {
          ok: false,
          status: res.status,
          error: `la app respondió ${res.status}`,
        }
      } catch (error) {
        // Un error de red no se propaga: es un fallo de entrega más, y quien
        // llama decide si reintentar. Si escapara, el mensaje quedaría sin
        // marcar y el ticker no volvería a tomarlo nunca.
        return { ok: false, status: 0, error: (error as Error).message }
      }
    },
  }
}
