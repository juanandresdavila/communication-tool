import { describe, expect, it } from 'vitest'
import { sanearJson } from './sanear-json.js'

function textoSucio(s: string): boolean {
  return s.includes('\u0000') || !s.isWellFormed()
}

/** true si algún string o clave, recorrido entero, trae U+0000 o un surrogate suelto. */
function tieneSucio(v: unknown): boolean {
  if (typeof v === 'string') return textoSucio(v)
  if (Array.isArray(v)) return v.some(tieneSucio)
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).some(([k, x]) => textoSucio(k) || tieneSucio(x))
  }
  return false
}

describe('sanearJson', () => {
  it('saca el U+0000 de un valor, de una clave y de un array anidado', () => {
    const entrada = {
      'cl\u0000ave': 'va\u0000lor',
      lista: ['a', { 'x\u0000': ['\u0000', 'ok'] }],
    }

    const resultado = sanearJson(entrada)

    expect(tieneSucio(entrada)).toBe(true)
    expect(tieneSucio(resultado)).toBe(false)
    expect(resultado).toEqual({
      'cl�ave': 'va�lor',
      lista: ['a', { 'x�': ['�', 'ok'] }],
    })
  })

  it('cambia un surrogate suelto por U+FFFD y la letra que sigue sobrevive', () => {
    expect(sanearJson('a\ud800b')).toBe('a�b')
    expect(sanearJson('a\udc00b')).toBe('a�b')
  })

  it('no toca los pares de surrogates ni el U+200D', () => {
    const entrada = { t: 'hola 😀 👨‍👩‍👧' }
    expect(sanearJson(entrada)).toEqual(entrada)
  })

  it('deja iguales los números, los booleanos y null', () => {
    const entrada = { n: 1, b: true, z: null }
    expect(sanearJson(entrada)).toEqual(entrada)
    expect(sanearJson(7)).toBe(7)
    expect(sanearJson(null)).toBeNull()
  })

  it('no muta la entrada', () => {
    const entrada = { 'k\u0000': ['a\u0000'] }
    sanearJson(entrada)
    expect(entrada).toEqual({ 'k\u0000': ['a\u0000'] })
  })
})
