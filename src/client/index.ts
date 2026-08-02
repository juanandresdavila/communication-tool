import { firmaValida } from './signature.js'
import type {
  Channel,
  IncomingMessage,
  Messaging,
  OutgoingMessage,
} from './types.js'

export type { Channel, IncomingMessage, Messaging, OutgoingMessage }
export { firmaValida, headerDeFirma } from './signature.js'

export interface CommToolConfig {
  /** Sin barra final, por ejemplo `https://communication-tool-beta.vercel.app`. */
  baseUrl: string
  /** La API key de la app. Va en el header, nunca en la URL. */
  apiKey: string
  /** El secreto con el que comm-tool firma las entregas hacia esta app. */
  deliverySecret: string
  /** Inyectable para que los tests no toquen la red. */
  fetchFn?: typeof fetch
  now?: () => Date
}

interface RespuestaEnvio {
  messageId?: string
  providerMessageId?: string
  code?: string
  error?: string
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function createCommToolMessaging(config: CommToolConfig): Messaging {
  const doFetch = config.fetchFn ?? fetch
  const now = config.now ?? (() => new Date())

  return {
    async sendMessage(msg: OutgoingMessage) {
      const res = await doFetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          userId: msg.userId,
          text: msg.text,
          kind: msg.kind,
          ...(msg.replyToMessageId
            ? { replyToMessageId: msg.replyToMessageId }
            : {}),
          ...(msg.template ? { template: msg.template } : {}),
        }),
      })

      const cuerpo = (await res
        .json()
        .catch(() => null)) as RespuestaEnvio | null

      if (!res.ok || !cuerpo?.providerMessageId) {
        // Nunca se incluye la request ni la clave en el error: solo el código
        // que devolvió comm-tool.
        throw new Error(
          `comm-tool rechazó el envío: ${cuerpo?.code ?? res.status}`,
        )
      }

      // El id DEL PROVEEDOR, no el de comm-tool. Es el que después matchea
      // contra el `replyToMessageId` de un entrante.
      return { messageId: cuerpo.providerMessageId }
    },

    async parseIncoming(req: Request): Promise<IncomingMessage | null> {
      // El cuerpo se lee como texto porque la firma es sobre los bytes
      // exactos: volver a serializar el objeto parseado cambiaría el HMAC.
      const cuerpo = await req.text()
      const firma = req.headers.get('X-Comm-Signature') ?? ''

      if (!firmaValida(config.deliverySecret, cuerpo, firma, now().getTime())) {
        return null
      }

      const datos: unknown = JSON.parse(cuerpo) as unknown
      if (!esObjeto(datos)) return null

      const { messageId, userId, channel, text, receivedAt } = datos
      if (
        typeof messageId !== 'string' ||
        typeof userId !== 'string' ||
        typeof channel !== 'string' ||
        typeof text !== 'string' ||
        typeof receivedAt !== 'string'
      ) {
        return null
      }

      const replyTo = datos['replyToMessageId']

      return {
        userId,
        text,
        channel: channel as Channel,
        messageId,
        ...(typeof replyTo === 'string' ? { replyToMessageId: replyTo } : {}),
        receivedAt,
        raw: datos['raw'],
      }
    },
  }
}
