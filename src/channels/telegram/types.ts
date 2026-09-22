interface UpdateBase {
  updateId: string
  chatId: string
  /**
   * En un mensaje, el del usuario. En un toque, el del BOT que tenía el
   * botón: es el que se edita después.
   */
  messageId: string
}

export interface UpdateDeMensaje extends UpdateBase {
  tipo: 'message'
  text: string
  replyToMessageId: string | undefined
}

export interface UpdateDeToque extends UpdateBase {
  tipo: 'callback'
  /** Lo que hay que pasarle a `answerCallbackQuery`. */
  callbackId: string
  /** Opaco para comm-tool, y puede no ser el de ningún botón nuestro. */
  data: string
}

/** Forma normalizada de un update, independiente del proveedor. */
export type UpdateNormalizado = UpdateDeMensaje | UpdateDeToque

export interface Comando {
  nombre: string
  args: string
}
