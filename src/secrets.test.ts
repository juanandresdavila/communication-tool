import { describe, expect, it } from 'vitest'
import { createSecretReader } from './secrets.js'

describe('createSecretReader', () => {
  it('devuelve el valor de la variable pedida', () => {
    const leer = createSecretReader({ TOKEN_GYM: 'abc123' })
    expect(leer('TOKEN_GYM')).toBe('abc123')
  })

  it('falla nombrando la variable que falta', () => {
    const leer = createSecretReader({})
    expect(() => leer('TOKEN_GYM')).toThrow(/TOKEN_GYM/)
  })

  it('trata una variable vacía como faltante', () => {
    const leer = createSecretReader({ TOKEN_GYM: '' })
    expect(() => leer('TOKEN_GYM')).toThrow(/TOKEN_GYM/)
  })

  it('no filtra el valor en el mensaje de error', () => {
    const leer = createSecretReader({ OTRA: 'secretisimo' })
    expect(() => leer('TOKEN_GYM')).not.toThrow(/secretisimo/)
  })
})
