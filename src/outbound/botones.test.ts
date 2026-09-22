import { describe, expect, it } from 'vitest'
import { botonesSchema } from './botones.js'

const valido = (b: unknown) => botonesSchema.safeParse(b).success

describe('botonesSchema', () => {
  it('acepta filas de botones con data o con url', () => {
    expect(
      valido([
        [
          { text: 'Tarea', data: 's1:abc:t:tarea' },
          { text: 'Nota', data: 's1:abc:t:nota' },
        ],
        [{ text: 'Abrir', url: 'https://study.jadd.com.ar' }],
      ]),
    ).toBe(true)
  })

  it('cuenta el data en bytes y no en caracteres', () => {
    // 61 caracteres ASCII + un emoji de 4 bytes = 65 bytes, pero .length da
    // 63: una validación por .length lo dejaría pasar y Telegram lo rechazaría.
    const pasado = 'a'.repeat(61) + '🎓'
    expect(pasado.length).toBe(63)
    expect(valido([[{ text: 'x', data: pasado }]])).toBe(false)

    const justo = 'a'.repeat(60) + '🎓' // 64 bytes
    expect(valido([[{ text: 'x', data: justo }]])).toBe(true)
  })

  it('rechaza un data vacío', () => {
    expect(valido([[{ text: 'x', data: '' }]])).toBe(false)
  })

  it('exige exactamente uno de data o url', () => {
    expect(
      valido([[{ text: 'x', data: 'a', url: 'https://ejemplo.test' }]]),
    ).toBe(false)
    expect(valido([[{ text: 'x' }]])).toBe(false)
  })

  it('rechaza una url que no es https', () => {
    expect(valido([[{ text: 'x', url: 'http://ejemplo.test' }]])).toBe(false)
    expect(valido([[{ text: 'x', url: 'no es una url' }]])).toBe(false)
  })

  it('rechaza un botón sin texto', () => {
    expect(valido([[{ text: '', data: 'a' }]])).toBe(false)
  })

  it('rechaza una fila vacía y un teclado vacío', () => {
    expect(valido([[]])).toBe(false)
    expect(valido([])).toBe(false)
  })

  it('rechaza más de 100 botones', () => {
    const fila = Array.from({ length: 10 }, (_, i) => ({
      text: `b${i}`,
      data: `d${i}`,
    }))
    expect(valido(Array.from({ length: 10 }, () => fila))).toBe(true)
    expect(valido(Array.from({ length: 11 }, () => fila))).toBe(false)
  })
})
