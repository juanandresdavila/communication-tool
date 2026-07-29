import { describe, expect, it } from 'vitest'
import { formatApiKey, hashApiKey } from './api-key.js'

describe('hashApiKey', () => {
  it('devuelve un sha256 en hexadecimal de 64 caracteres', () => {
    const hash = hashApiKey('ct_abc123')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('es determinista', () => {
    expect(hashApiKey('ct_abc123')).toBe(hashApiKey('ct_abc123'))
  })

  it('cambia por completo ante un cambio mínimo', () => {
    expect(hashApiKey('ct_abc123')).not.toBe(hashApiKey('ct_abc124'))
  })

  it('coincide con el sha256 conocido de una cadena de referencia', () => {
    // echo -n "abc" | shasum -a 256
    expect(hashApiKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('formatApiKey', () => {
  it('antepone el prefijo ct_ al material aleatorio en hexadecimal', () => {
    expect(formatApiKey(new Uint8Array([0, 255, 16]))).toBe('ct_00ff10')
  })
})
