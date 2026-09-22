/**
 * El contrato de mensajería del spec, §El contrato. Nació como el MISMO
 * archivo que vive en `src/lib/messaging/types.ts` de GymTracker y de Study
 * Master, y que no se separen en lo obligatorio es lo que verifica la suite de
 * conformidad.
 *
 * Desde `v0.3.0` las copias pueden diferir en lo OPCIONAL: botones, toques y
 * edición entraron así a propósito, para que una app que no los usa se quede
 * en la versión anterior sin tocar nada.
 *
 * Este archivo no importa nada, ni siquiera de este repo. Es la raíz de que el
 * paquete sea delgado.
 */

export type Channel = 'telegram' | 'whatsapp'

/**
 * Un botón de un teclado inline. Exactamente uno de `data` o `url`.
 *
 * `data` vuelve en `IncomingMessage.callback.data` cuando alguien lo toca. Son
 * de 1 a 64 BYTES UTF-8, no caracteres: un emoji ocupa 4.
 *
 * 🚨 Lo que vuelve puede no ser ninguno de los `data` que mandaste. La doc de
 * Telegram lo avisa (*«the message originated the query can contain no
 * callback buttons with this data»*): validalo siempre, como cualquier entrada.
 */
export interface Button {
  text: string
  data?: string
  url?: string
}

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
  /**
   * Presente cuando la entrega es un TOQUE de un botón y no un mensaje, y
   * entonces `text` llega como `""`. `messageId` es el id del proveedor del
   * mensaje que tenía el botón: el mismo que devolvió `sendMessage`, así que
   * sirve para editarlo.
   */
  callback?: { data: string; messageId: string }
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
  /**
   * Filas de botones inline. Con `idempotencyKey`, un reintento reenvía los
   * botones de la primera vez, igual que el texto.
   */
  buttons?: Button[][]
}

export interface EditMessage {
  userId: string
  /** El id DEL PROVEEDOR: el que devolvió `sendMessage`. */
  messageId: string
  text: string
  /** Sin botones, el teclado que tenía el mensaje se saca. */
  buttons?: Button[][]
}

export interface Messaging {
  /** Devuelve el id del mensaje enviado: es la mecánica de correlación. */
  sendMessage(msg: OutgoingMessage): Promise<{ messageId: string }>
  /** `null` cuando el request no es un mensaje procesable. */
  parseIncoming(req: Request): Promise<IncomingMessage | null>
  /**
   * Edita un mensaje que el bot ya mandó. Opcional porque el transporte de
   * Telegram directo de GymTracker no lo implementa, y no lo necesita.
   */
  editMessage?(msg: EditMessage): Promise<void>
}
