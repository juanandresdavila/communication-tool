import { describe, expect, it } from 'vitest'
import { createFakeDb } from './fake-db.js'

describe('createFakeDb', () => {
  it('por defecto responde al ping', async () => {
    await expect(createFakeDb().ping()).resolves.toBeUndefined()
  })

  it('falla el ping cuando se lo pide', async () => {
    await expect(createFakeDb({ pingFalla: true }).ping()).rejects.toThrow()
  })

  it('cuenta cuántas veces se llamó al ping', async () => {
    const db = createFakeDb()
    await db.ping()
    await db.ping()
    expect(db.pings).toBe(2)
  })
})
