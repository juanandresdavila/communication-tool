import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { internalAuth } from './internal-auth.js'

function armar() {
  const server = new Hono()
  server.use('/interno', internalAuth('el-secreto'))
  server.get('/interno', (c) => c.json({ ok: true }))
  return server
}

describe('internalAuth', () => {
  it('deja pasar con el secreto correcto', async () => {
    const res = await armar().request('/interno', {
      headers: { Authorization: 'Bearer el-secreto' },
    })
    expect(res.status).toBe(200)
  })

  it('rechaza sin header', async () => {
    expect((await armar().request('/interno')).status).toBe(401)
  })

  it('rechaza con el secreto incorrecto', async () => {
    const res = await armar().request('/interno', {
      headers: { Authorization: 'Bearer otro' },
    })
    expect(res.status).toBe(401)
  })

  it('rechaza un secreto de largo distinto sin explotar', async () => {
    const res = await armar().request('/interno', {
      headers: { Authorization: 'Bearer x' },
    })
    expect(res.status).toBe(401)
  })
})
