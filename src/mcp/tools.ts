import * as z from 'zod'
import { enviarSaliente, type SendDeps } from '../outbound/send.js'

/** Telegram corta los mensajes de texto en 4096 caracteres. Va declarado en el
 *  inputSchema para que el modelo parta un digest largo en vez de comerse un
 *  rechazo. */
const LARGO_MAXIMO_TEXTO = 4096

export interface DefinicionTool {
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required: string[]
    additionalProperties: false
  }
}

/**
 * Solo tools de salida. `programar` y `cancelar_programado` quedan afuera a
 * propósito: el scheduler dispara posteando a un schedule_callback_url HTTP y
 * un cliente MCP no expone ninguno, así que un programado creado desde acá se
 * marcaría failed sin postear a nadie. Una tool que falla en silencio es peor
 * que una tool que no está.
 */
export const TOOLS: readonly DefinicionTool[] = [
  {
    name: 'enviar_mensaje',
    title: 'Enviar un mensaje de Telegram',
    description:
      'Manda un mensaje de Telegram al usuario. El texto viaja tal cual: este servicio transporta, no interpreta ni reescribe. Es de una sola mano, el usuario no puede contestar por este canal.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description:
            'Identificador del destinatario. Hoy el único vinculado es "juan".',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: LARGO_MAXIMO_TEXTO,
          description: `El texto del mensaje. Máximo ${LARGO_MAXIMO_TEXTO} caracteres, que es el límite de Telegram: si el contenido es más largo, mandá varios mensajes en vez de uno.`,
        },
        idempotencyKey: {
          type: 'string',
          maxLength: 200,
          description:
            'Opcional. Reintentar el mismo envío con la misma clave entrega el mensaje una sola vez. Conviene una clave estable por envío, por ejemplo "pendientes-2026-09-02".',
        },
      },
      required: ['userId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ver_contacto',
    title: 'Ver si un usuario está vinculado',
    description:
      'Dice si un usuario tiene un contacto de Telegram vinculado. Sirve para chequear antes de mandar. Nunca devuelve el chat id.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description:
            'Identificador del destinatario. Hoy el único vinculado es "juan".',
        },
      },
      required: ['userId'],
      additionalProperties: false,
    },
  },
]

export type ResultadoTool =
  | { tipo: 'ok'; texto: string }
  | { tipo: 'error_de_ejecucion'; texto: string }
  | { tipo: 'argumentos_invalidos'; detalle: string }
  | { tipo: 'tool_desconocida' }

const enviarArgs = z.object({
  userId: z.string().min(1),
  text: z.string().min(1).max(LARGO_MAXIMO_TEXTO),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

const verArgs = z.object({ userId: z.string().min(1) })

/**
 * La distinción entre los cuatro resultados no es cosmética: el spec de MCP
 * separa el error de protocolo, que el modelo no puede arreglar, del error de
 * ejecución, que sí. Devolver un not_linked como error de protocolo hace que
 * el modelo abandone en vez de corregirse.
 */
export async function ejecutarTool(
  deps: SendDeps,
  appId: string,
  nombre: string,
  argumentos: unknown,
): Promise<ResultadoTool> {
  if (nombre === 'enviar_mensaje') return await enviar(deps, appId, argumentos)
  if (nombre === 'ver_contacto') return await ver(deps, appId, argumentos)
  return { tipo: 'tool_desconocida' }
}

async function enviar(
  deps: SendDeps,
  appId: string,
  argumentos: unknown,
): Promise<ResultadoTool> {
  const parseado = enviarArgs.safeParse(argumentos)
  if (!parseado.success) {
    return {
      tipo: 'argumentos_invalidos',
      detalle: `Argumentos inválidos para enviar_mensaje: ${parseado.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    }
  }

  // kind queda fijo: un cliente MCP nunca está contestando un entrante, así
  // que no tiene sentido exponerlo como argumento.
  const resultado = await enviarSaliente(deps, appId, {
    userId: parseado.data.userId,
    text: parseado.data.text,
    kind: 'notification',
    replyToMessageId: null,
    template: null,
    idempotencyKey: parseado.data.idempotencyKey ?? null,
    // Las tools MCP siguen siendo sólo texto (spec del bot interactivo, §1).
    buttons: null,
  })

  switch (resultado.estado) {
    case 'sent':
    case 'duplicate':
      return {
        tipo: 'ok',
        texto: `Mensaje entregado por Telegram (id del proveedor: ${resultado.providerMessageId}).`,
      }
    case 'not_linked':
      return {
        tipo: 'error_de_ejecucion',
        texto: `No hay ningún contacto de Telegram vinculado para el userId "${parseado.data.userId}". Probá ver_contacto para confirmar cuál está vinculado.`,
      }
    case 'no_bot':
      return {
        tipo: 'error_de_ejecucion',
        texto: 'Esta app no tiene un bot de Telegram activo configurado.',
      }
    case 'in_progress':
      return {
        tipo: 'error_de_ejecucion',
        texto:
          'Ya hay un envío en curso con esa idempotencyKey y no se sabe si salió. No reintentes con la misma clave.',
      }
    case 'send_failed':
      return {
        tipo: 'error_de_ejecucion',
        texto: `Telegram rechazó el envío: ${resultado.error}`,
      }
  }
}

async function ver(
  deps: SendDeps,
  appId: string,
  argumentos: unknown,
): Promise<ResultadoTool> {
  const parseado = verArgs.safeParse(argumentos)
  if (!parseado.success) {
    return {
      tipo: 'argumentos_invalidos',
      detalle: 'Argumentos inválidos para ver_contacto: falta userId.',
    }
  }

  const contacto = await deps.contacts.findByAppUserId(
    appId,
    'telegram',
    parseado.data.userId,
  )

  // Nunca se devuelve externalId: la app no conoce el chat id.
  return {
    tipo: 'ok',
    texto: contacto
      ? `El usuario "${parseado.data.userId}" está vinculado por telegram desde ${contacto.linkedAt}.`
      : `El usuario "${parseado.data.userId}" no está vinculado.`,
  }
}
