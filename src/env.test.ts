import { describe, expect, it } from 'vitest'
import { parseEnv } from './env'

describe('parseEnv', () => {
  it('devuelve la config cuando DATABASE_URL está presente', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
      DATABASE_URL: 'postgres://x',
    })
  })

  it('falla nombrando la variable que falta', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/)
  })

  it('falla si DATABASE_URL está vacía', () => {
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
  })

  it('ignora variables desconocidas', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://x', OTRA: 'y' })).toEqual({
      DATABASE_URL: 'postgres://x',
    })
  })
})
