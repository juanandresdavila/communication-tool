import { describe, expect, it } from 'vitest'
import { parseDatabaseEnv, parseEnv } from './env.js'

const BUENO = 'a1'.repeat(32)
const FILTRABLE = 'zqx'.repeat(4)

describe('parseEnv', () => {
  it('devuelve la config cuando están todas las variables', () => {
    expect(
      parseEnv({ DATABASE_URL: 'postgres://x', INTERNAL_SECRET: BUENO }),
    ).toEqual({
      DATABASE_URL: 'postgres://x',
      INTERNAL_SECRET: BUENO,
    })
  })

  it('falla nombrando la variable que falta', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/)
  })

  it('falla si DATABASE_URL está vacía', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: '', INTERNAL_SECRET: BUENO }),
    ).toThrow(/DATABASE_URL/)
  })

  it('falla si falta INTERNAL_SECRET', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://x' })).toThrow(
      /INTERNAL_SECRET/,
    )
  })

  it.each(['[SENSITIVE]', '"[SENSITIVE]"', 's', 'a'.repeat(31)])(
    'parseEnv rechaza INTERNAL_SECRET=%j',
    (valor) => {
      expect(() =>
        parseEnv({ DATABASE_URL: 'postgres://x', INTERNAL_SECRET: valor }),
      ).toThrow(/INTERNAL_SECRET/)
    },
  )

  it('el mensaje de un INTERNAL_SECRET inválido no contiene el valor', () => {
    let mensaje = ''
    try {
      parseEnv({ DATABASE_URL: 'postgres://x', INTERNAL_SECRET: FILTRABLE })
    } catch (e) {
      mensaje = (e as Error).message
    }
    expect(mensaje).toMatch(/INTERNAL_SECRET/)
    expect(mensaje).not.toContain('zqx')
  })

  it('ignora variables desconocidas', () => {
    expect(
      parseEnv({
        DATABASE_URL: 'postgres://x',
        INTERNAL_SECRET: BUENO,
        OTRA: 'y',
      }),
    ).toEqual({ DATABASE_URL: 'postgres://x', INTERNAL_SECRET: BUENO })
  })
})

describe('parseDatabaseEnv', () => {
  it('alcanza con DATABASE_URL', () => {
    // El runner de migraciones no habla con Telegram ni atiende el ticker:
    // exigirle el resto del entorno rompe `bun run db:migrate` en cualquier
    // lado que solo tenga la cadena de conexión — que es justo lo que
    // documenta .env.example.
    expect(parseDatabaseEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
      DATABASE_URL: 'postgres://x',
    })
  })

  it('no exige INTERNAL_SECRET', () => {
    expect(() => parseDatabaseEnv({ DATABASE_URL: 'postgres://x' })).not.toThrow()
  })

  it('sigue fallando sin DATABASE_URL', () => {
    expect(() => parseDatabaseEnv({})).toThrow(/DATABASE_URL/)
  })
})
