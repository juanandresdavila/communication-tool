import { describe, expect, it } from 'vitest'
import { ALFABETO, generateLinkCode, normalizeLinkCode } from './link-code.js'

describe('ALFABETO', () => {
  it('tiene 31 caracteres sin ambigüedades', () => {
    expect(ALFABETO).toHaveLength(31)
    for (const prohibido of ['0', 'O', '1', 'I', 'L']) {
      expect(ALFABETO).not.toContain(prohibido)
    }
  })
})

describe('generateLinkCode', () => {
  it('produce un código de 6 caracteres del alfabeto', () => {
    const code = generateLinkCode(new Uint8Array([0, 1, 2, 3, 4, 5]))
    expect(code).toBe('ABCDEF')
  })

  it('mapea cada byte por índice en el alfabeto', () => {
    const code = generateLinkCode(new Uint8Array([30, 29, 0, 0, 0, 0]))
    expect(code).toBe(`${ALFABETO[30]}${ALFABETO[29]}AAAA`)
  })

  it('descarta los bytes que introducirían sesgo de módulo', () => {
    // 248 y 255 son ≥ 248 y deben saltearse por completo.
    const code = generateLinkCode(new Uint8Array([248, 0, 255, 1, 2, 3, 4, 5]))
    expect(code).toBe('ABCDEF')
  })

  it('acepta bytes iguales a 247, que sí son válidos', () => {
    // 247 % 31 = 30 → el último carácter del alfabeto.
    const code = generateLinkCode(new Uint8Array([247, 0, 0, 0, 0, 0]))
    expect(code).toBe(`${ALFABETO[30]}AAAAA`)
  })

  it('falla si no hay bytes utilizables suficientes', () => {
    expect(() => generateLinkCode(new Uint8Array([0, 1, 2]))).toThrow(/bytes/i)
  })
})

describe('normalizeLinkCode', () => {
  it('pasa a mayúsculas', () => {
    expect(normalizeLinkCode('abcdef')).toBe('ABCDEF')
  })

  it('saca espacios y guiones', () => {
    expect(normalizeLinkCode(' ABC-DEF ')).toBe('ABCDEF')
  })

  it('devuelve null si queda algo fuera del alfabeto', () => {
    expect(normalizeLinkCode('ABC$EF')).toBeNull()
  })

  it('rechaza los caracteres ambiguos en vez de adivinar', () => {
    // 0, O, 1, I y L no están en el alfabeto justamente para que un código
    // generado nunca los contenga. Si el usuario tipeó uno, se equivocó: no
    // se corrige por su cuenta, porque adivinar produciría un código válido
    // pero distinto del que se emitió.
    for (const ambiguo of ['O', '0', 'I', 'L', '1']) {
      expect(normalizeLinkCode(`ABCDE${ambiguo}`)).toBeNull()
    }
  })

  it('devuelve null si no mide 6 caracteres', () => {
    expect(normalizeLinkCode('ABCDE')).toBeNull()
    expect(normalizeLinkCode('ABCDEFG')).toBeNull()
  })
})
