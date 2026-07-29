/** Forma normalizada de un update, independiente del proveedor. */
export interface UpdateNormalizado {
  updateId: string
  chatId: string
  messageId: string
  text: string
  replyToMessageId: string | undefined
}

export interface Comando {
  nombre: string
  args: string
}
