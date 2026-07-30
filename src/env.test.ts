import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

describe('parseEnv', () => {
  it('devuelve la config cuando están todas las variables', () => {
    expect(
      parseEnv({ DATABASE_URL: 'postgres://x', INTERNAL_SECRET: 's' }),
    ).toEqual({
      DATABASE_URL: 'postgres://x',
      INTERNAL_SECRET: 's',
    })
  })

  it('falla nombrando la variable que falta', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/)
  })

  it('falla si DATABASE_URL está vacía', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: '', INTERNAL_SECRET: 's' }),
    ).toThrow(/DATABASE_URL/)
  })

  it('falla si falta INTERNAL_SECRET', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://x' })).toThrow(
      /INTERNAL_SECRET/,
    )
  })

  it('ignora variables desconocidas', () => {
    expect(
      parseEnv({
        DATABASE_URL: 'postgres://x',
        INTERNAL_SECRET: 's',
        OTRA: 'y',
      }),
    ).toEqual({ DATABASE_URL: 'postgres://x', INTERNAL_SECRET: 's' })
  })
})
