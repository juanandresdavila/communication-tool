/**
 * El contrato de mensajería del spec, §El contrato. Es el MISMO archivo que
 * vive en `src/lib/messaging/types.ts` de GymTracker: que las dos copias no
 * se separen es justamente lo que verifica la suite de conformidad.
 *
 * Este archivo no importa nada, ni siquiera de este repo. Es la raíz de que el
 * paquete sea delgado.
 */

export type Channel = 'telegram' | 'whatsapp'

export interface IncomingMessage {
  /** El `app_user_id` YA RESUELTO. Nunca un chat_id. */
  userId: string
  /** Un entrante sin texto llega con `""`, no con null: decide la app. */
  text: string
  channel: Channel
  /**
   * El id de la ENTREGA, que es lo que hace idempotente al receptor. Con
   * Telegram directo lleva el `update_id`; con comm-tool, su `messageId`.
   */
  messageId: string
  /**
   * El id del MENSAJE respondido, en el espacio de ids **del proveedor** —el
   * mismo que devuelve `sendMessage`—, para poder correlacionar.
   */
  replyToMessageId?: string
  receivedAt: string
  raw: unknown
}

export interface OutgoingMessage {
  userId: string
  text: string
  /**
   * En Telegram no cambia nada. Existe para que el día que haya WhatsApp el
   * call site ya declare su intención.
   */
  kind: 'reply' | 'notification'
  replyToMessageId?: string
  template?: { name: string; vars: Record<string, string> }
  /**
   * Clave de idempotencia, **best-effort**: el transporte puede ignorarla.
   *
   * Con comm-tool, dos envíos con la misma clave producen un solo mensaje y la
   * misma respuesta. Con Telegram directo no hay dónde deduplicar y se ignora,
   * así que quien la use tiene que tolerar que no haga nada — por eso no está
   * en la suite de conformidad como garantía de deduplicación.
   *
   * El caso que la justifica: un callback de programado que se reintenta
   * porque su respuesta se perdió, y sin clave mandaría el aviso dos veces.
   */
  idempotencyKey?: string
}

export interface Messaging {
  /** Devuelve el id del mensaje enviado: es la mecánica de correlación. */
  sendMessage(msg: OutgoingMessage): Promise<{ messageId: string }>
  /** `null` cuando el request no es un mensaje procesable. */
  parseIncoming(req: Request): Promise<IncomingMessage | null>
}
