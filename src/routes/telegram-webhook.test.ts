import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Contact, LinkCode } from '../db/ports.js'
import {
  createFakeAppsRepo,
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeInboundMessagesRepo,
  createFakeLinkCodesRepo,
  unApp,
  unBot,
  unContacto,
  unLinkCode,
} from '../test-support/fake-repos.js'
import { telegramFalso } from '../test-support/fake-telegram.js'
import {
  crearPresupuesto,
  PRESUPUESTO_POR_DEFECTO,
  type PresupuestoDeRespuestas,
} from '../presupuesto.js'
import { telegramWebhookRoutes } from './telegram-webhook.js'

const SECRETO = 'secreto-del-webhook'
const AHORA = new Date('2026-07-28T12:00:00.000Z')

function armar(
  opts: {
    contactos?: Contact[]
    codigos?: LinkCode[]
    entregaFalla?: boolean
    envioFalla?: boolean
    envioColgado?: boolean
    respuestaFalla?: boolean
    presupuesto?: PresupuestoDeRespuestas
  } = {},
) {
  const enviados: { chatId: string; text: string }[] = []
  const respondidos: string[] = []
  const entregados: string[] = []
  const contacts = createFakeContactsRepo(opts.contactos ?? [])
  const linkCodes = createFakeLinkCodesRepo(opts.codigos ?? [])
  const inbound = createFakeInboundMessagesRepo([])

  // waitUntil ejecuta al toque en los tests: la entrega tiene que haber
  // terminado cuando el request vuelve, o las aserciones correrían antes.
  const pendientes: Promise<unknown>[] = []

  const server = new Hono()
  server.route(
    '/',
    telegramWebhookRoutes({
      bots: createFakeBotsRepo([unBot()]),
      contacts,
      linkCodes,
      inbound,
      presupuesto:
        opts.presupuesto ?? crearPresupuesto(PRESUPUESTO_POR_DEFECTO),
      apps: createFakeAppsRepo([{ hash: 'h', app: unApp() }]),
      delivery: {
        async entregar(p) {
          entregados.push(p.deliveryId)
          return opts.entregaFalla
            ? { ok: false, status: 500, error: 'la app respondió 500' }
            : { ok: true, status: 200 }
        },
      },
      secrets: () => SECRETO,
      now: () => AHORA,
      sleep: async () => {},
      waitUntil: (p) => {
        pendientes.push(p)
      },
      telegram: {
        ...telegramFalso(),
        async sendMessage(_token, chatId, text) {
          enviados.push({ chatId, text })
          // Un envío que no resuelve nunca por su cuenta: sirve para probar
          // que el webhook NO lo espera.
          if (opts.envioColgado) return new Promise<never>(() => {})
          if (opts.envioFalla) {
            throw new Error('Telegram rechazó sendMessage: chat not found')
          }
          return { messageId: '1' }
        },
        async answerCallbackQuery(_token, callbackId) {
          respondidos.push(callbackId)
          if (opts.respuestaFalla) {
            throw new Error('Telegram rechazó answerCallbackQuery: query is too old')
          }
        },
      },
    }),
  )

  return {
    server,
    enviados,
    respondidos,
    entregados,
    contacts,
    linkCodes,
    inbound,
    /** Espera a que termine lo que quedó en waitUntil. */
    async drenar() {
      await Promise.all(pendientes)
    },
  }
}

function update(text: string, chatId = '12345') {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: Number(chatId), type: 'private' },
      date: 1_785_264_000,
      text,
    },
  }
}

async function postear(
  server: Hono,
  cuerpo: unknown,
  secreto: string | null = SECRETO,
  slug = 'gym',
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secreto !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secreto

  return server.request(`/webhooks/telegram/${slug}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(cuerpo),
  })
}

describe('seguridad y ruteo', () => {
  it('rechaza sin el header de secreto', async () => {
    const { server } = armar()
    expect((await postear(server, update('hola'), null)).status).toBe(401)
  })

  it('rechaza con un secreto incorrecto', async () => {
    const { server } = armar()
    expect((await postear(server, update('hola'), 'otro')).status).toBe(401)
  })

  it('devuelve 404 para un bot que no existe', async () => {
    const { server } = armar()
    expect(
      (await postear(server, update('hola'), SECRETO, 'no-existe')).status,
    ).toBe(404)
  })

  it('acepta un update que no puede parsear y responde 200', async () => {
    const { server, enviados } = armar()
    const res = await postear(server, { update_id: 1, callback_query: {} })
    expect(res.status).toBe(200)
    expect(enviados).toHaveLength(0)
  })
})

describe('chat no vinculado', () => {
  it('responde con el unlinked_message del bot', async () => {
    const { server, enviados } = armar()
    const res = await postear(server, update('banca 4x10 60'))

    expect(res.status).toBe(200)
    expect(enviados).toEqual([
      { chatId: '12345', text: 'Vinculá tu cuenta con /vincular <código>.' },
    ])
  })

  it('contesta 200 sin esperar a que salga la respuesta', async () => {
    // El envío no resuelve nunca. Si el webhook lo esperara, este test no
    // fallaría con un assert: colgaría hasta el timeout de Vitest. Es
    // deliberado, es la única forma honesta de probar que NO se espera.
    // Ojo: no se llama a drenar(), que por definición nunca terminaría.
    const { server } = armar({ envioColgado: true })

    const res = await postear(server, update('hola'))

    expect(res.status).toBe(200)
  })

  it('contesta 200 aunque el envío a Telegram falle', async () => {
    const { server } = armar({ envioFalla: true })

    const res = await postear(server, update('hola'))

    expect(res.status).toBe(200)
  })

  it('la promesa que se programa resuelve aunque el envío falle', async () => {
    // 🚨 El motivo de este test: el waitUntil de server.ts es `void promesa`,
    // que NO captura rejections, y sendMessage tira cuando Telegram rechaza.
    // Sin el .catch del webhook, acá quedaría una unhandled rejection que en
    // producción no la agarra nadie.
    const { server, drenar } = armar({ envioFalla: true })

    await postear(server, update('hola'))

    await expect(drenar()).resolves.toBeUndefined()
  })
})

describe('/vincular', () => {
  it('vincula con un código válido', async () => {
    const { server, enviados, contacts } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })
    const res = await postear(server, update('/vincular ABCDEF'))

    expect(res.status).toBe(200)
    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(
      (await contacts.findByExternalId('app-1', 'telegram', '12345'))?.appUserId,
    ).toBe('user-1')
  })

  it('acepta el alias /link y el código en minúsculas y con guiones', async () => {
    const { server, contacts } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF' })],
    })
    await postear(server, update('/link abc-def'))
    expect(
      await contacts.findByExternalId('app-1', 'telegram', '12345'),
    ).not.toBeNull()
  })

  it('pide el código si el comando viene sin argumentos', async () => {
    const { server, enviados } = armar()
    await postear(server, update('/vincular'))
    expect(enviados[0]?.text).toMatch(/código/i)
  })

  it('avisa cuando el código está vencido, sin consumirlo', async () => {
    const { server, enviados, linkCodes } = armar({
      codigos: [
        unLinkCode({ code: 'ABCDEF', expiresAt: '2026-07-28T11:00:00.000Z' }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vencido/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('avisa cuando el código ya fue usado', async () => {
    const { server, enviados } = armar({
      codigos: [
        unLinkCode({ code: 'ABCDEF', usedAt: '2026-07-28T11:00:00.000Z' }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))
    expect(enviados[0]?.text).toMatch(/ya se us/i)
  })

  it('trata un código de otra app como inexistente', async () => {
    const { server, enviados, linkCodes } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appId: 'otra-app' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/no existe/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('repetir el mismo /vincular contesta que ya estabas vinculado', async () => {
    // Secuencia REAL, no un estado armado a mano: vincular y repetir. Un test
    // que construye "contacto existente + código sin usar" describe un estado
    // imposible —si hay contacto, el código se consumió— y por eso no detecta
    // que el chequeo de `usedAt` se coma la rama de idempotencia.
    const { server, enviados } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })

    await postear(server, update('/vincular ABCDEF'))
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(enviados[1]?.text).toMatch(/ya estab/i)
    expect(enviados[1]?.text).not.toMatch(/ya se us/i)
  })

  it('es idempotente aunque el código figure como usado', async () => {
    const { server, enviados } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      codigos: [
        unLinkCode({
          code: 'ABCDEF',
          appUserId: 'user-1',
          usedAt: '2026-07-28T11:00:00.000Z',
        }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/ya estab/i)
  })

  it('rechaza vincular un chat que ya pertenece a otra cuenta, sin quemar el código', async () => {
    const { server, enviados, linkCodes } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-2' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/otra cuenta/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })
})

describe('persistencia y entrega', () => {
  it('guarda el crudo antes de intentar entregar', async () => {
    const { server, inbound, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
    })
    await postear(server, update('banca 4x10 60'))
    await drenar()

    const guardado = await inbound.findById('msg-1')
    expect(guardado?.text).toBe('banca 4x10 60')
    expect(guardado?.appUserId).toBe('user-1')
    expect(guardado?.raw).toMatchObject({ update_id: 1 })
  })

  it('descarta un update_id repetido sin entregar dos veces', async () => {
    const { server, entregados, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
    })

    await postear(server, update('hola'))
    await postear(server, update('hola'))
    await drenar()

    expect(entregados).toHaveLength(1)
  })

  it('registra como skipped el mensaje de un chat no vinculado', async () => {
    const { server, inbound, entregados, drenar } = armar()
    await postear(server, update('hola'))
    await drenar()

    const guardado = await inbound.findById('msg-1')
    expect(guardado?.deliveryStatus).toBe('skipped')
    expect(guardado?.appUserId).toBeNull()
    expect(entregados).toHaveLength(0)
  })

  it('no registra ni entrega los comandos de vinculación', async () => {
    // /vincular es de comm-tool, no de la app: entregarlo sería filtrar un
    // comando de identidad al dominio de otro.
    const { server, inbound, entregados, drenar } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF' })],
    })
    await postear(server, update('/vincular ABCDEF'))
    await drenar()

    expect(await inbound.findById('msg-1')).toBeNull()
    expect(entregados).toHaveLength(0)
  })

  it('no guarda el crudo de un chat no vinculado, pero sí la fila', async () => {
    // El comentario de arriba del insert dice que el crudo se persiste SIEMPRE
    // "si el parser de la app o la entrega fallan". Una fila skipped no se
    // entrega nunca y ningún camino lee su raw, así que esa razón no la cubre.
    // La FILA sí se conserva: es lo único que avisa que alguien encontró el bot.
    const { server, inbound, drenar } = armar()
    await postear(server, update('hola'))
    await drenar()

    const guardado = await inbound.findById('msg-1')
    expect(guardado?.deliveryStatus).toBe('skipped')
    expect(guardado?.text).toBe('hola')
    expect(guardado?.raw).toBeNull()
  })

  it('contesta 200 aunque la entrega falle', async () => {
    // Un 5xx a Telegram provoca reintentos que ya cubre el backoff propio.
    const { server, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      entregaFalla: true,
    })
    const res = await postear(server, update('hola'))
    await drenar()
    expect(res.status).toBe(200)
  })
})

describe('presupuesto de respuestas', () => {
  /** Mismo update con otro update_id, para esquivar el dedupe. */
  function updateN(n: number, text = 'hola', chatId = '12345') {
    return { ...update(text, chatId), update_id: n }
  }

  it('deja de contestarle al chat que se pasa del presupuesto', async () => {
    const { server, enviados } = armar({
      presupuesto: crearPresupuesto({
        porVentana: 2,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, updateN(1))
    await postear(server, updateN(2))
    await postear(server, updateN(3))

    expect(enviados).toHaveLength(2)
  })

  it('un /vincular también consume presupuesto', async () => {
    // La regla es única y no tiene excepciones: si /vincular quedara afuera,
    // seguiría habiendo un camino de amplificación sin tope.
    const { server, enviados } = armar({
      presupuesto: crearPresupuesto({
        porVentana: 1,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, updateN(1, '/vincular ZZZZZZ'))
    await postear(server, updateN(2, '/vincular ZZZZZZ'))

    expect(enviados).toHaveLength(1)
  })

  it('chats distintos no se comen el presupuesto entre sí', async () => {
    // Guarda contra la clave equivocada: si se contara por bot en vez de por
    // (bot, chat), el primer desconocido que llegue dejaría sin respuesta a
    // todos los demás, incluido alguien que viene a vincularse de verdad.
    const { server, enviados } = armar({
      presupuesto: crearPresupuesto({
        porVentana: 1,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, updateN(1, 'hola', '111'))
    await postear(server, updateN(2, 'hola', '222'))

    expect(enviados.map((e) => e.chatId)).toEqual(['111', '222'])
  })

  it('el contacto vinculado se entrega igual con el presupuesto agotado', async () => {
    // Guarda contra la implementación equivocada plausible: poner el
    // presupuesto delante de la ENTREGA y no solo de la respuesta. Con
    // porVentana en 0 no sale ninguna respuesta, y la entrega tiene que salir
    // igual.
    const { server, entregados, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      presupuesto: crearPresupuesto({
        porVentana: 0,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, update('banca 4x10 60'))
    await drenar()

    expect(entregados).toHaveLength(1)
  })
})

function toque(data = 's1:abc:t:tarea', chatId = '12345', updateId = 50) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(chatId), is_bot: false, first_name: 'Juan' },
      message: {
        message_id: 77,
        chat: { id: Number(chatId), type: 'private' },
        date: 1_785_264_000,
        text: '¿Lo guardo como…?',
      },
      chat_instance: '-1',
      data,
    },
  }
}

describe('toques de botones', () => {
  const VINCULADO = [unContacto({ externalId: '12345', appUserId: 'user-1' })]

  it('guarda y entrega el toque de un contacto vinculado', async () => {
    const { server, inbound, entregados, drenar } = armar({
      contactos: VINCULADO,
    })

    const res = await postear(server, toque())
    await drenar()

    expect(res.status).toBe(200)
    const guardado = await inbound.findById('msg-1')
    expect(guardado).toMatchObject({
      kind: 'callback',
      text: '',
      callbackData: 's1:abc:t:tarea',
      callbackMessageId: '77',
      appUserId: 'user-1',
    })
    expect(entregados).toEqual(['msg-1'])
  })

  it('contesta el toque con answerCallbackQuery', async () => {
    const { server, respondidos, drenar } = armar({ contactos: VINCULADO })

    await postear(server, toque())
    await drenar()

    expect(respondidos).toEqual(['cb-50'])
  })

  it('contesta el toque aunque el presupuesto del chat esté agotado', async () => {
    // El presupuesto es contra la amplificación: un toque no le escribe nada
    // al chat, y sin la respuesta el botón queda cargando para siempre.
    const { server, respondidos, drenar } = armar({
      contactos: VINCULADO,
      presupuesto: crearPresupuesto({
        porVentana: 0,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, toque())
    await drenar()

    expect(respondidos).toEqual(['cb-50'])
  })

  it('un toque repetido no se contesta ni se entrega dos veces', async () => {
    const { server, respondidos, entregados, drenar } = armar({
      contactos: VINCULADO,
    })

    await postear(server, toque())
    await postear(server, toque())
    await drenar()

    expect(respondidos).toHaveLength(1)
    expect(entregados).toHaveLength(1)
  })

  it('el toque de un chat no vinculado se contesta y queda skipped, sin unlinkedMessage', async () => {
    const { server, inbound, respondidos, enviados, entregados, drenar } =
      armar()

    await postear(server, toque())
    await drenar()

    expect(respondidos).toEqual(['cb-50'])
    expect(enviados).toEqual([])
    expect(entregados).toEqual([])
    const guardado = await inbound.findById('msg-1')
    expect(guardado?.deliveryStatus).toBe('skipped')
    expect(guardado?.raw).toBeNull()
  })

  it('contesta 200 y no deja rejections sueltas si answerCallbackQuery falla', async () => {
    const { server, drenar } = armar({
      contactos: VINCULADO,
      respuestaFalla: true,
    })

    const res = await postear(server, toque())

    expect(res.status).toBe(200)
    await expect(drenar()).resolves.toBeUndefined()
  })
})

describe('/start con código', () => {
  it('vincula con /start <código>, que es lo que manda el link t.me', async () => {
    const { server, contacts, inbound, enviados } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })

    await postear(server, update('/start ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(
      (await contacts.findByExternalId('app-1', 'telegram', '12345'))?.appUserId,
    ).toBe('user-1')
    expect(await inbound.findById('msg-1')).toBeNull()
  })

  it('/start sin código no es vinculación: sigue el camino de un mensaje', async () => {
    // Un usuario ya vinculado que abre el bot de nuevo no puede recibir
    // «Mandame el código junto al comando».
    const { server, enviados, entregados, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
    })

    await postear(server, update('/start'))
    await drenar()

    expect(enviados).toEqual([])
    expect(entregados).toHaveLength(1)
  })
})
