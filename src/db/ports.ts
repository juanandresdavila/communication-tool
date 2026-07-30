export type Channel = 'telegram' | 'whatsapp'

export interface App {
  id: string
  slug: string
  name: string
  deliveryUrl: string
  scheduleCallbackUrl: string | null
  deliverySecretEnv: string
  active: boolean
}

export interface Bot {
  id: string
  appId: string
  channel: Channel
  slug: string
  username: string | null
  tokenEnv: string
  webhookSecretEnv: string
  unlinkedMessage: string
  active: boolean
}

export interface Contact {
  id: string
  appId: string
  channel: Channel
  externalId: string
  appUserId: string
  linkedAt: string
  blocked: boolean
}

export interface LinkCode {
  code: string
  appId: string
  appUserId: string
  expiresAt: string
  usedAt: string | null
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped'

export interface InboundMessage {
  id: string
  botId: string
  appId: string
  channel: Channel
  providerUpdateId: string
  externalId: string
  appUserId: string | null
  text: string
  replyToMessageId: string | null
  raw: unknown
  receivedAt: string
  deliveryStatus: DeliveryStatus
  deliveryAttempts: number
  nextAttemptAt: string | null
  deliveredAt: string | null
  lastError: string | null
}

export interface AppsRepo {
  findByApiKeyHash(hash: string): Promise<App | null>
  findById(id: string): Promise<App | null>
}

export interface BotsRepo {
  findBySlug(slug: string): Promise<Bot | null>
}

export interface ContactsRepo {
  findByExternalId(
    appId: string,
    channel: Channel,
    externalId: string,
  ): Promise<Contact | null>
  findByAppUserId(
    appId: string,
    channel: Channel,
    appUserId: string,
  ): Promise<Contact | null>
  create(input: {
    appId: string
    channel: Channel
    externalId: string
    appUserId: string
  }): Promise<Contact>
  deleteByAppUserId(
    appId: string,
    channel: Channel,
    appUserId: string,
  ): Promise<boolean>
}

export interface InboundMessagesRepo {
  /**
   * Inserta el crudo. Devuelve null si `(bot_id, provider_update_id)` ya
   * existía: eso es un reintento de Telegram y no hay que reprocesarlo.
   */
  insertIfNew(input: {
    botId: string
    appId: string
    channel: Channel
    providerUpdateId: string
    externalId: string
    appUserId: string | null
    text: string
    replyToMessageId: string | null
    raw: unknown
    deliveryStatus: DeliveryStatus
    nextAttemptAt: Date | null
  }): Promise<InboundMessage | null>

  findById(id: string): Promise<InboundMessage | null>

  /**
   * Toma hasta `limite` pendientes vencidos y les pone un *lease*: corre su
   * `next_attempt_at` hacia adelante para que otro tick no los tome mientras
   * se procesan, y para que vuelvan a estar disponibles si este tick muere a
   * la mitad. **No toca el contador de intentos** — de eso se encargan las
   * marcas de resultado, así el total de 5 sale igual lo llame el webhook o
   * el ticker.
   */
  claimPendientes(ahora: Date, limite: number): Promise<InboundMessage[]>

  marcarEntregado(id: string, ahora: Date): Promise<void>
  /** Incrementa `delivery_attempts`. */
  marcarReintento(id: string, proximoIntento: Date, error: string): Promise<void>
  /** Incrementa `delivery_attempts`. */
  marcarFallido(id: string, error: string): Promise<void>
  /** Vuelve a poner en `pending` un mensaje fallido, con el contador en cero. */
  reencolar(id: string, ahora: Date): Promise<InboundMessage | null>
}

export interface LinkCodesRepo {
  create(input: {
    code: string
    appId: string
    appUserId: string
    expiresAt: Date
  }): Promise<void>
  /** Lectura sin efectos, para dar un mensaje de error preciso. */
  find(code: string): Promise<LinkCode | null>
  /**
   * Consume el código de forma atómica. Devuelve null si ya estaba usado,
   * venció, o no existe: la condición vive en el WHERE, no en el código.
   */
  redeem(code: string, ahora: Date): Promise<LinkCode | null>
}
