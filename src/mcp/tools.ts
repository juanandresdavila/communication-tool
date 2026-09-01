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
