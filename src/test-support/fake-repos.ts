import type {
  App,
  AppsRepo,
  Bot,
  BotsRepo,
  Contact,
  ContactsRepo,
  LinkCode,
  LinkCodesRepo,
} from '../db/ports.js'

export function unApp(over: Partial<App> = {}): App {
  return {
    id: 'app-1',
    slug: 'gym-tracker',
    name: 'GymTracker',
    deliveryUrl: 'https://gym.example/api/messaging/inbound',
    scheduleCallbackUrl: null,
    deliverySecretEnv: 'DELIVERY_SECRET_GYM',
    active: true,
    ...over,
  }
}

export function unBot(over: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    appId: 'app-1',
    channel: 'telegram',
    slug: 'gym',
    username: 'GymTrackerBot',
    tokenEnv: 'TELEGRAM_TOKEN_GYM',
    webhookSecretEnv: 'TELEGRAM_WEBHOOK_SECRET_GYM',
    unlinkedMessage: 'Vinculá tu cuenta con /vincular <código>.',
    active: true,
    ...over,
  }
}

export function unContacto(over: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    appId: 'app-1',
    channel: 'telegram',
    externalId: '12345',
    appUserId: 'user-1',
    linkedAt: '2026-07-28T10:00:00.000Z',
    blocked: false,
    ...over,
  }
}

export function unLinkCode(over: Partial<LinkCode> = {}): LinkCode {
  return {
    code: 'ABCDEF',
    appId: 'app-1',
    appUserId: 'user-1',
    expiresAt: '2026-07-28T23:00:00.000Z',
    usedAt: null,
    ...over,
  }
}

export function createFakeAppsRepo(
  entradas: { hash: string; app: App }[],
): AppsRepo {
  return {
    async findByApiKeyHash(hash) {
      return entradas.find((e) => e.hash === hash)?.app ?? null
    },
  }
}

export function createFakeBotsRepo(bots: Bot[]): BotsRepo {
  return {
    async findBySlug(slug) {
      return bots.find((b) => b.slug === slug) ?? null
    },
  }
}

export function createFakeContactsRepo(inicial: Contact[]): ContactsRepo {
  const contactos = [...inicial]
  let siguienteId = inicial.length + 1

  return {
    async findByExternalId(appId, channel, externalId) {
      return (
        contactos.find(
          (c) =>
            c.appId === appId &&
            c.channel === channel &&
            c.externalId === externalId,
        ) ?? null
      )
    },
    async findByAppUserId(appId, channel, appUserId) {
      return (
        contactos.find(
          (c) =>
            c.appId === appId &&
            c.channel === channel &&
            c.appUserId === appUserId,
        ) ?? null
      )
    },
    async create(input) {
      const creado: Contact = {
        id: `contact-${siguienteId++}`,
        linkedAt: '2026-07-28T10:00:00.000Z',
        blocked: false,
        ...input,
      }
      contactos.push(creado)
      return creado
    },
    async deleteByAppUserId(appId, channel, appUserId) {
      const i = contactos.findIndex(
        (c) =>
          c.appId === appId &&
          c.channel === channel &&
          c.appUserId === appUserId,
      )
      if (i === -1) return false
      contactos.splice(i, 1)
      return true
    },
  }
}

export function createFakeLinkCodesRepo(inicial: LinkCode[]): LinkCodesRepo {
  const codigos = [...inicial]

  return {
    async create(input) {
      codigos.push({
        code: input.code,
        appId: input.appId,
        appUserId: input.appUserId,
        expiresAt: input.expiresAt.toISOString(),
        usedAt: null,
      })
    },
    async find(code) {
      return codigos.find((c) => c.code === code) ?? null
    },
    async redeem(code, ahora) {
      const encontrado = codigos.find((c) => c.code === code)
      if (!encontrado) return null
      if (encontrado.usedAt !== null) return null
      if (new Date(encontrado.expiresAt) <= ahora) return null
      encontrado.usedAt = ahora.toISOString()
      return { ...encontrado }
    },
  }
}
