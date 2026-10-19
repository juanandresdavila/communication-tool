import { describe, expect, it } from 'vitest'
import { neutralizarControles } from './neutralizar-controles.js'

const PROHIBIDOS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

describe('neutralizarControles', () => {
  it.each([
    ['OSC con BEL', '\u001b]0;x\u0007'],
    ['CSI con ESC', '\u001b[2J'],
    ['CSI de C1', '\u009b31m'],
    ['override bidi (RLO)', '\u202e'],
    ['DEL', '\u007f'],
    ['marca de dirección', '\u200e\u200f\u061c'],
    ['aislados bidi', '\u2066\u2067\u2068\u2069'],
  ])('no deja ningún control: %s', (_nombre, entrada) => {
    expect(PROHIBIDOS.test(neutralizarControles(entrada))).toBe(false)
  })

  it('escapa ESC como \\u{1b}', () => {
    expect(neutralizarControles('\u001b[2J')).toBe('\\u{1b}[2J')
  })

  it('escapa el salto de línea', () => {
    expect(neutralizarControles('línea\nnueva')).toBe('línea\\u{a}nueva')
  })

  it('deja intacto el texto normal, con emoji compuesto', () => {
    const texto = 'ñandú 👨‍👩‍👧 ok'
    expect(neutralizarControles(texto)).toBe(texto)
  })

  it.each(['\u001f', '\u009f', '\u202e', '\u2069'])(
    'escapa el borde del rango %j',
    (c) => {
      const salida = neutralizarControles(c)
      expect(salida).toBe('\\u{' + c.codePointAt(0)!.toString(16) + '}')
    },
  )

  it.each(['\u0020', '\u00a0', '\u202f', '\u2065', '\u206a', '\u200d'])(
    'deja intacto el carácter justo fuera del rango %j',
    (c) => {
      expect(neutralizarControles(c)).toBe(c)
    },
  )
})
