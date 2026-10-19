import { describe, expect, it } from 'vitest'
import { neutralizarControles } from './neutralizar-controles.js'

const PROHIBIDOS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/

describe('neutralizarControles', () => {
  it.each([
    ['OSC con BEL', '\u001b]0;x\u0007'],
    ['CSI con ESC', '\u001b[2J'],
    ['CSI de C1', '\u009b31m'],
    ['override bidi (RLO)', '‮'],
    ['DEL', '\u007f'],
    ['marca de dirección', '‎‏؜'],
    ['aislados bidi', '⁦⁧⁨⁩'],
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
})
