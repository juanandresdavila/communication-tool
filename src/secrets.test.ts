import { describe, expect, it } from 'vitest'
import {
  createSecretReader,
  LARGO_MINIMO_SECRETO,
  motivoSecretoInvalido,
} from './secrets.js'

const BUENO = 'a1'.repeat(32) // 64 caracteres, la forma de `openssl rand -hex 32`
const FILTRABLE = 'zqx'.repeat(4) // 12 caracteres: si aparece en un mensaje, se filtró

const INVALIDOS = [
  '[SENSITIVE]',
  '"[SENSITIVE]"',
  's',
  'a'.repeat(31),
  `"${BUENO}"`,
  `'${BUENO}'`,
  `[${BUENO}]`,
  ` ${BUENO}`,
  `${BUENO} `,
  `${BUENO}\r`, // un .env editado en Windows
  `${BUENO}\n`,
  FILTRABLE,
  `${FILTRABLE}[SENSITIVE]${FILTRABLE}${FILTRABLE}`,
  // Sin corchetes: largo, sin comillas ni espacios. Solo lo caza la palabra.
  `SENSITIVE${BUENO}`,
]

describe('motivoSecretoInvalido', () => {
  it('acepta uno de 64 hex y uno de exactamente 32', () => {
    expect(motivoSecretoInvalido(BUENO)).toBeNull()
    expect(motivoSecretoInvalido('a'.repeat(LARGO_MINIMO_SECRETO))).toBeNull()
  })

  it.each(INVALIDOS)('rechaza %j', (valor) => {
    expect(motivoSecretoInvalido(valor)).not.toBeNull()
  })

  it('el motivo nunca contiene el valor', () => {
    expect(motivoSecretoInvalido(FILTRABLE)).not.toContain('zqx')
    expect(
      motivoSecretoInvalido(`${FILTRABLE}[SENSITIVE]${FILTRABLE}${FILTRABLE}`),
    ).not.toContain('zqx')
  })

  it('devuelve el motivo exacto de cada regla, en orden', () => {
    expect(motivoSecretoInvalido('[SENSITIVE]')).toBe(
      'contiene el marcador SENSITIVE de Vercel',
    )
    expect(motivoSecretoInvalido(`SENSITIVE${BUENO}`)).toBe(
      'contiene el marcador SENSITIVE de Vercel',
    )
    expect(motivoSecretoInvalido(`"${BUENO}"`)).toBe(
      'empieza o termina con comillas o corchetes',
    )
    expect(motivoSecretoInvalido(`${BUENO}\n`)).toBe(
      'tiene espacios al principio o al final',
    )
    expect(motivoSecretoInvalido('a'.repeat(31))).toBe(
      'tiene menos de 32 caracteres',
    )
  })
})

describe('createSecretReader', () => {
  it('devuelve el valor de la variable pedida', () => {
    const leer = createSecretReader({ TOKEN_GYM: BUENO })
    expect(leer('TOKEN_GYM')).toBe(BUENO)
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

  it.each(INVALIDOS)('tira con %j, nombrando la variable y sin el valor', (valor) => {
    const leer = createSecretReader({ TOKEN_GYM: valor })
    expect(() => leer('TOKEN_GYM')).toThrow(/TOKEN_GYM/)
    let mensaje = ''
    try {
      leer('TOKEN_GYM')
    } catch (e) {
      mensaje = (e as Error).message
    }
    expect(mensaje).not.toBe('')
    expect(mensaje).not.toContain('zqx')
  })
})
