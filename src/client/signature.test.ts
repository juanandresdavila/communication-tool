import { describe, expect, it } from 'vitest'
import { firmaValida, headerDeFirma } from './signature.js'

const SECRETO = 'secreto'
const CUERPO = '{"a":1}'
const T = 1_785_264_000

// Golden value calculado aparte:
//   createHmac('sha256','secreto').update('1785264000.{"a":1}').digest('hex')
const HMAC_ESPERADO =
  'f57cee0bacf4b9a6811defa9aa5a918b78b9e7b7665a19cd08ce7d78273df5b3'

describe('headerDeFirma', () => {
  it('produce el formato t=<unix>,v1=<hex> con el HMAC correcto', () => {
    expect(headerDeFirma(SECRETO, CUERPO, T)).toBe(`t=${T},v1=${HMAC_ESPERADO}`)
  })

  it('firma el timestamp junto al cuerpo, no el cuerpo solo', () => {
    // Si el timestamp no entrara en la firma, estos dos coincidirían y un
    // atacante podría reusar una firma vieja con un timestamp nuevo.
    expect(headerDeFirma(SECRETO, CUERPO, T)).not.toBe(
      headerDeFirma(SECRETO, CUERPO, T + 1).replace(String(T + 1), String(T)),
    )
  })

  it('cambia por completo si cambia el secreto', () => {
    expect(headerDeFirma('otro', CUERPO, T)).not.toBe(
      headerDeFirma(SECRETO, CUERPO, T),
    )
  })
})

describe('firmaValida', () => {
  it('acepta una firma recién emitida', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, T * 1000)).toBe(true)
  })

  it('acepta dentro de la ventana de 5 minutos', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, (T + 299) * 1000)).toBe(true)
  })

  it('rechaza fuera de la ventana de 5 minutos', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, (T + 301) * 1000)).toBe(false)
  })

  it('rechaza un timestamp del futuro fuera de tolerancia', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, CUERPO, header, (T - 301) * 1000)).toBe(false)
  })

  it('rechaza si el cuerpo cambió', () => {
    const header = headerDeFirma(SECRETO, CUERPO, T)
    expect(firmaValida(SECRETO, '{"a":2}', header, T * 1000)).toBe(false)
  })

  it('rechaza headers mal formados sin explotar', () => {
    for (const malo of ['', 'chamuyo', 't=abc,v1=xx', `t=${T}`, `v1=abc`]) {
      expect(firmaValida(SECRETO, CUERPO, malo, T * 1000)).toBe(false)
    }
  })
})
