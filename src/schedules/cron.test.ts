import { describe, expect, it } from 'vitest'
import { cronValido, proximaEjecucion, zonaValida } from './cron.js'

const BA = 'America/Argentina/Buenos_Aires'

describe('proximaEjecucion', () => {
  it('resuelve las 22:00 de Buenos Aires en UTC', () => {
    // Buenos Aires es UTC-3 todo el año: las 22:00 locales son las 01:00 UTC
    // del día siguiente. Si esto diera 22:00 UTC, el check-in llegaría a las
    // 19:00 hora del usuario.
    const desde = new Date('2026-08-02T12:00:00.000Z')
    expect(proximaEjecucion('0 22 * * *', BA, desde)?.toISOString()).toBe(
      '2026-08-03T01:00:00.000Z',
    )
  })

  it('devuelve la ocurrencia siguiente, nunca la que ya pasó', () => {
    const desde = new Date('2026-08-03T02:00:00.000Z')
    const proxima = proximaEjecucion('0 22 * * *', BA, desde)
    expect(proxima?.getTime()).toBeGreaterThan(desde.getTime())
    expect(proxima?.toISOString()).toBe('2026-08-04T01:00:00.000Z')
  })

  it('respeta la zona horaria: la misma expresión da distinto en Madrid', () => {
    const desde = new Date('2026-08-02T12:00:00.000Z')
    const ba = proximaEjecucion('0 22 * * *', BA, desde)
    const madrid = proximaEjecucion('0 22 * * *', 'Europe/Madrid', desde)
    expect(ba?.toISOString()).not.toBe(madrid?.toISOString())
  })

  it('cruza un salto de horario de verano sin trabarse', () => {
    // Madrid adelanta el 29/3/2026 a las 02:00 -> 03:00. Un programado a las
    // 02:30 ese día no existe. Lo que NO puede pasar es devolver null o una
    // fecha anterior a `desde`: eso trabaría el programado para siempre.
    const desde = new Date('2026-03-28T12:00:00.000Z')
    const proxima = proximaEjecucion('30 2 * * *', 'Europe/Madrid', desde)
    expect(proxima).not.toBeNull()
    expect(proxima?.getTime()).toBeGreaterThan(desde.getTime())
  })

  it('devuelve null ante una expresión inválida en vez de explotar', () => {
    expect(proximaEjecucion('esto no es cron', BA, new Date())).toBeNull()
  })

  it('devuelve null ante una zona inválida en vez de explotar', () => {
    expect(
      proximaEjecucion('0 22 * * *', 'Marte/Olympus', new Date()),
    ).toBeNull()
  })
})

describe('cronValido', () => {
  it('acepta expresiones de cinco campos', () => {
    expect(cronValido('0 22 * * *')).toBe(true)
    expect(cronValido('*/15 * * * *')).toBe(true)
  })

  it('rechaza cualquier cosa', () => {
    expect(cronValido('')).toBe(false)
    expect(cronValido('esto no es cron')).toBe(false)
    expect(cronValido('99 99 * * *')).toBe(false)
  })
})

describe('zonaValida', () => {
  it('acepta zonas IANA', () => {
    expect(zonaValida(BA)).toBe(true)
    expect(zonaValida('UTC')).toBe(true)
  })

  it('rechaza lo que no es una zona', () => {
    expect(zonaValida('Marte/Olympus')).toBe(false)
    expect(zonaValida('')).toBe(false)
  })
})
