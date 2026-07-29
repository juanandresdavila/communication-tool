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

export interface AppsRepo {
  findByApiKeyHash(hash: string): Promise<App | null>
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
