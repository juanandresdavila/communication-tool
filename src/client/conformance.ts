import type { Messaging } from './types.js'

/**
 * La suite de conformidad del spec, §Suite de conformidad.
 *
 * Se exporta como DATOS, no como tests: una lista de casos que cada repo
 * engancha a su propio runner. Así el paquete no depende de Vitest, y
 * GymTracker puede correrla con el suyo sin alinear versiones.
 *
 *     import { CASOS_DE_CONFORMIDAD } from 'communication-tool/conformance'
 *     for (const caso of CASOS_DE_CONFORMIDAD) {
 *       it(caso.nombre, () => caso.ejecutar(contexto))
 *     }
 */

export interface ContextoDeConformidad {
  /** La implementación bajo prueba, ya armada con sus dobles. */
  messaging: Messaging
  /** Un request de entrada válido, que corresponde a `esperado`. */
  requestValido(): Request | Promise<Request>
  /** El mismo request pero con la firma o el secreto mal. */
  requestInvalido(): Request | Promise<Request>
  /** Un request válido cuyo mensaje no trae texto. */
  requestSinTexto(): Request | Promise<Request>
  /** Lo que `parseIncoming(requestValido())` tiene que devolver. */
  esperado: { userId: string; text: string; messageId: string }
  /** Un userId que SÍ está vinculado, y uno que no. */
  userIdVinculado: string
  userIdSinVincular: string
}

export interface CasoDeConformidad {
  nombre: string
  ejecutar(ctx: ContextoDeConformidad): Promise<void>
}

/** Assert mínimo propio: el paquete no depende de ningún runner. */
function afirmar(condicion: boolean, mensaje: string): asserts condicion {
  if (!condicion) throw new Error(`conformidad: ${mensaje}`)
}

function igual(actual: unknown, esperado: unknown, que: string): void {
  afirmar(
    actual === esperado,
    `${que} — esperaba ${JSON.stringify(esperado)}, recibí ${JSON.stringify(actual)}`,
  )
}

export const CASOS_DE_CONFORMIDAD: CasoDeConformidad[] = [
  {
    nombre: 'parseIncoming devuelve el userId ya resuelto',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      igual(res.userId, ctx.esperado.userId, 'userId')
    },
  },
  {
    nombre: 'parseIncoming devuelve el texto del mensaje',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      igual(res.text, ctx.esperado.text, 'text')
    },
  },
  {
    nombre: 'parseIncoming devuelve el id de la entrega como messageId',
    async ejecutar(ctx) {
      // Es la clave de idempotencia del receptor. Si las dos
      // implementaciones no coinciden en QUÉ id es, migrar duplica mensajes.
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      igual(res.messageId, ctx.esperado.messageId, 'messageId')
    },
  },
  {
    nombre: 'parseIncoming marca el canal',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      afirmar(
        res.channel === 'telegram' || res.channel === 'whatsapp',
        `channel inválido: ${res.channel}`,
      )
    },
  },
  {
    nombre: 'parseIncoming devuelve un receivedAt en ISO 8601',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      afirmar(
        !Number.isNaN(new Date(res.receivedAt).getTime()),
        `receivedAt no parsea como fecha: ${res.receivedAt}`,
      )
    },
  },
  {
    nombre: 'parseIncoming devuelve null si el request no está autenticado',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestInvalido())
      igual(res, null, 'un request sin autenticar')
    },
  },
  {
    nombre: 'un entrante sin texto llega con text vacío, no con null',
    async ejecutar(ctx) {
      // El spec lo dice explícito: una foto o un audio no se descartan.
      // Devolver null acá haría que el dominio nunca se entere del mensaje.
      const res = await ctx.messaging.parseIncoming(await ctx.requestSinTexto())
      afirmar(res !== null, 'un mensaje sin texto NO debe devolver null')
      igual(res.text, '', 'text de un mensaje sin texto')
    },
  },
  {
    nombre: 'parseIncoming nunca filtra un chat_id al dominio',
    async ejecutar(ctx) {
      // La invariante central del spec. `raw` queda excluido a propósito: el
      // crudo del proveedor lo trae por contrato, y el dominio no lo mira.
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      const sinRaw = { ...res, raw: undefined }
      const serializado = JSON.stringify(sinRaw)
      for (const prohibido of ['chatId', 'chat_id', 'externalId']) {
        afirmar(
          !serializado.includes(prohibido),
          `el mensaje expone ${prohibido} al dominio`,
        )
      }
    },
  },
  {
    nombre: 'sendMessage devuelve un messageId no vacío',
    async ejecutar(ctx) {
      const res = await ctx.messaging.sendMessage({
        userId: ctx.userIdVinculado,
        text: 'mensaje de conformidad',
        kind: 'reply',
      })
      afirmar(
        typeof res.messageId === 'string' && res.messageId.length > 0,
        `sendMessage devolvió un messageId inservible: ${JSON.stringify(res.messageId)}`,
      )
    },
  },
  {
    nombre: 'sendMessage tira si el usuario no está vinculado',
    async ejecutar(ctx) {
      // Las dos implementaciones tienen que FALLAR, no devolver un id falso.
      // Si una tirara y la otra no, migrar cambiaría el flujo de errores del
      // dominio sin que nadie lo note.
      let tiro = false
      try {
        await ctx.messaging.sendMessage({
          userId: ctx.userIdSinVincular,
          text: 'no debería salir',
          kind: 'reply',
        })
      } catch {
        tiro = true
      }
      afirmar(tiro, 'sendMessage a un usuario sin vincular tiene que tirar')
    },
  },
]
