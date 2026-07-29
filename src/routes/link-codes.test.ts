import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { LinkCodesRepo } from '../db/ports.js'
import { ALFABETO } from '../identity/link-code.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { createFakeLinkCodesRepo, unApp } from '../test-support/fake-repos.js'
import { linkCodeRoutes } from './link-codes.js'

const AHORA = new Date('2026-07-28T12:00:00.000Z')

function armar(linkCodes: LinkCodesRepo = createFakeLinkCodesRepo([])) {
  // Hono<ConVariablesDeApp> y no Hono a secas: c.set('app', ...) está tipado.
  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route(
    '/',
    linkCodeRoutes({
      linkCodes,
      now: () => AHORA,
      randomBytes: (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i)),
    }),
  )
  return server
}

async function postear(server: Hono<ConVariablesDeApp>, body: unknown) {
  return server.request('/v1/link-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /v1/link-codes', () => {
  it('emite un código con vencimiento por defecto de 15 minutos', async () => {
    const res = await postear(armar(), { userId: 'user-1' })
    expect(res.status).toBe(201)

    const cuerpo = (await res.json()) as { code: string; expiresAt: string }
    expect(cuerpo.code).toHaveLength(6)
    expect([...cuerpo.code].every((ch) => ALFABETO.includes(ch))).toBe(true)
    expect(cuerpo.expiresAt).toBe('2026-07-28T12:15:00.000Z')
  })

  it('respeta un ttlSeconds explícito', async () => {
    const res = await postear(armar(), { userId: 'user-1', ttlSeconds: 60 })
    const cuerpo = (await res.json()) as { expiresAt: string }
    expect(cuerpo.expiresAt).toBe('2026-07-28T12:01:00.000Z')
  })

  it('guarda el código contra la app autenticada', async () => {
    const repo = createFakeLinkCodesRepo([])
    const res = await postear(armar(repo), { userId: 'user-7' })
    const { code } = (await res.json()) as { code: string }

    const guardado = await repo.find(code)
    expect(guardado?.appId).toBe('app-1')
    expect(guardado?.appUserId).toBe('user-7')
  })

  it('rechaza sin userId', async () => {
    const res = await postear(armar(), {})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_request' })
  })

  it('rechaza un ttlSeconds fuera de rango', async () => {
    expect((await postear(armar(), { userId: 'u', ttlSeconds: 0 })).status).toBe(
      400,
    )
    expect(
      (await postear(armar(), { userId: 'u', ttlSeconds: 99_999 })).status,
    ).toBe(400)
  })
})
