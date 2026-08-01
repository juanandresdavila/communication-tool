import type {
  App,
  AppsRepo,
  Bot,
  BotsRepo,
  Contact,
  ContactsRepo,
  InboundMessage,
  InboundMessagesRepo,
  LinkCode,
  LinkCodesRepo,
  OutboundMessage,
  OutboundMessagesRepo,
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

export function unMensaje(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    botId: 'bot-1',
    appId: 'app-1',
    channel: 'telegram',
    providerUpdateId: '900001',
    externalId: '12345',
    appUserId: 'user-1',
    text: 'banca 4x10 60',
    replyToMessageId: null,
    raw: { update_id: 900_001 },
    receivedAt: '2026-07-29T12:00:00.000Z',
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    nextAttemptAt: '2026-07-29T12:00:00.000Z',
    deliveredAt: null,
    lastError: null,
    ...over,
  }
}

export function unSaliente(
  over: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    id: 'out-1',
    appId: 'app-1',
    contactId: 'contact-1',
    appUserId: 'user-1',
    channel: 'telegram',
    kind: 'reply',
    text: 'anotado: banca 4x10 60',
    template: null,
    replyToMessageId: null,
    providerMessageId: null,
    status: 'sending',
    error: null,
    idempotencyKey: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    ...over,
  }
}

export function createFakeOutboundMessagesRepo(
  inicial: OutboundMessage[] = [],
): OutboundMessagesRepo {
  // Copias, no referencias, igual que en el doble de entrantes: el repositorio
  // real emite SQL y no puede mutar el objeto que el llamador tiene en la mano.
  const mensajes = inicial.map((m) => ({ ...m }))
  let siguienteId = inicial.length + 1

  return {
    async claim(input) {
      const existente =
        input.idempotencyKey === null
          ? undefined
          : mensajes.find(
              (m) =>
                m.appId === input.appId &&
                m.idempotencyKey === input.idempotencyKey,
            )

      if (existente) {
        // Solo lo fallido se vuelve a tomar, y conserva su contenido original.
        if (existente.status !== 'failed') return null
        existente.status = 'sending'
        existente.error = null
        existente.providerMessageId = null
        return { ...existente }
      }

      const creado: OutboundMessage = {
        id: `out-${siguienteId++}`,
        providerMessageId: null,
        status: 'sending',
        error: null,
        createdAt: '2026-08-01T12:00:00.000Z',
        ...input,
      }
      mensajes.push(creado)
      return { ...creado }
    },

    async findByIdempotencyKey(appId, idempotencyKey) {
      const m = mensajes.find(
        (x) => x.appId === appId && x.idempotencyKey === idempotencyKey,
      )
      return m ? { ...m } : null
    },

    async marcarEnviado(id, providerMessageId) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.status = 'sent'
      m.providerMessageId = providerMessageId
      m.error = null
    },

    async marcarFallido(id, error) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.status = 'failed'
      m.error = error
    },
  }
}

export function createFakeAppsRepo(
  entradas: { hash: string; app: App }[],
): AppsRepo {
  return {
    async findByApiKeyHash(hash) {
      return entradas.find((e) => e.hash === hash)?.app ?? null
    },
    async findById(id) {
      return entradas.find((e) => e.app.id === id)?.app ?? null
    },
  }
}

export function createFakeInboundMessagesRepo(
  inicial: InboundMessage[] = [],
): InboundMessagesRepo {
  // Copias, no referencias: el repositorio real emite SQL y no puede mutar el
  // objeto que el llamador tiene en la mano. Si el doble lo mutara,
  // `entregarConReintentoInmediato` leería el contador ya incrementado por su
  // propia marca de reintento y se saltearía el reintento inmediato — un
  // reintento que en producción sí ocurre.
  const mensajes = inicial.map((m) => ({ ...m }))
  let siguienteId = inicial.length + 1

  return {
    async insertIfNew(input) {
      const duplicado = mensajes.some(
        (m) =>
          m.botId === input.botId &&
          m.providerUpdateId === input.providerUpdateId,
      )
      if (duplicado) return null

      const creado: InboundMessage = {
        id: `msg-${siguienteId++}`,
        receivedAt: '2026-07-29T12:00:00.000Z',
        deliveryAttempts: 0,
        deliveredAt: null,
        lastError: null,
        ...input,
        nextAttemptAt: input.nextAttemptAt?.toISOString() ?? null,
      }
      mensajes.push(creado)
      return creado
    },

    async findById(id) {
      // Snapshot, igual que una fila que vuelve de la base.
      const m = mensajes.find((x) => x.id === id)
      return m ? { ...m } : null
    },

    async claimPendientes(ahora, limite) {
      const elegibles = mensajes
        .filter(
          (m) =>
            m.deliveryStatus === 'pending' &&
            m.nextAttemptAt !== null &&
            new Date(m.nextAttemptAt) <= ahora,
        )
        .slice(0, limite)
      // Lease, no incremento: el contador lo mueven las marcas de resultado.
      const tomados = elegibles.map((m) => ({ ...m }))
      for (const m of elegibles) {
        m.nextAttemptAt = new Date(ahora.getTime() + 5 * 60_000).toISOString()
      }
      return tomados
    },

    async marcarEntregado(id, ahora) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.deliveryStatus = 'delivered'
      m.deliveredAt = ahora.toISOString()
      m.nextAttemptAt = null
      m.lastError = null
    },

    async marcarReintento(id, proximoIntento, error) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.deliveryStatus = 'pending'
      m.deliveryAttempts += 1
      m.nextAttemptAt = proximoIntento.toISOString()
      m.lastError = error
    },

    async marcarFallido(id, error) {
      const m = mensajes.find((x) => x.id === id)
      if (!m) return
      m.deliveryStatus = 'failed'
      m.deliveryAttempts += 1
      m.nextAttemptAt = null
      m.lastError = error
    },

    async reencolar(id, ahora) {
      const m = mensajes.find((x) => x.id === id)
      if (!m || m.deliveryStatus !== 'failed') return null
      m.deliveryStatus = 'pending'
      m.deliveryAttempts = 0
      m.nextAttemptAt = ahora.toISOString()
      m.lastError = null
      return { ...m }
    },
  }
}

export function createFakeBotsRepo(bots: Bot[]): BotsRepo {
  return {
    async findBySlug(slug) {
      return bots.find((b) => b.slug === slug) ?? null
    },
    async findByAppAndChannel(appId, channel) {
      return (
        bots.find(
          (b) => b.appId === appId && b.channel === channel && b.active,
        ) ?? null
      )
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
