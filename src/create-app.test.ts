import { describe, expect, it } from 'vitest'
import { createApp } from './create-app.js'
import { hashApiKey } from './identity/api-key.js'
import { LIMITE_BODY_BYTES } from './middleware/limite-de-body.js'
import { createFakeDeps } from './test-support/fake-deps.js'
import { createFakeAppsRepo, unApp } from './test-support/fake-repos.js'

const CLAVE = 'k'.repeat(48)

function armar() {
  return createApp(
    createFakeDeps({
      apps: createFakeAppsRepo([{ hash: hashApiKey(CLAVE), app: unApp() }]),
    }),
  )
}

/** Un JSON de EXACTAMENTE `bytes` bytes (relleno ASCII, que zod ignora). */
function cuerpoDe(bytes: number): string {
  const base = '{"userId":"u","relleno":""}'
  const cuerpo = base.replace('""', `"${'x'.repeat(bytes - base.length)}"`)
  expect(Buffer.byteLength(cuerpo, 'utf8')).toBe(bytes)
  return cuerpo
}

function postear(ruta: string, cuerpo: string, conClave = true) {
  return armar().request(ruta, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(conClave ? { Authorization: `Bearer ${CLAVE}` } : {}),
    },
    body: cuerpo,
  })
}

describe('createApp', () => {
  it('POST /internal/tick sin Authorization da 401 con la app compuesta', async () => {
    const res = await createApp(createFakeDeps()).request('/internal/tick', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })

  describe('tope de body', () => {
    it('un body de 300 KiB en /v1 da 413 payload_too_large', async () => {
      const res = await postear('/v1/link-codes', cuerpoDe(300 * 1024))
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ code: 'payload_too_large' })
    })

    it('un body de 300 KiB en /mcp da 413', async () => {
      const res = await postear('/mcp', cuerpoDe(300 * 1024))
      expect(res.status).toBe(413)
    })

    it('sin clave da 401 y no 413: la auth va primero', async () => {
      const v1 = await postear('/v1/link-codes', cuerpoDe(300 * 1024), false)
      const mcp = await postear('/mcp', cuerpoDe(300 * 1024), false)
      expect(v1.status).toBe(401)
      expect(mcp.status).toBe(401)
    })

    it('un body de exactamente el tope pasa y uno de un byte más da 413', async () => {
      const justo = await postear('/v1/link-codes', cuerpoDe(LIMITE_BODY_BYTES))
      expect(justo.status).toBe(201)

      const pasado = await postear(
        '/v1/link-codes',
        cuerpoDe(LIMITE_BODY_BYTES + 1),
      )
      expect(pasado.status).toBe(413)
      expect(await pasado.json()).toEqual({ code: 'payload_too_large' })
    })
  })
})
