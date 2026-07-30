import { describe, expect, it } from 'vitest'
import { esperaInmediata, MAX_INTENTOS, proximoIntentoMs } from './backoff.js'

describe('proximoIntentoMs', () => {
  it('sigue la escalera 10s, 1m, 5m, 30m', () => {
    expect(proximoIntentoMs(1)).toBe(10_000)
    expect(proximoIntentoMs(2)).toBe(60_000)
    expect(proximoIntentoMs(3)).toBe(300_000)
    expect(proximoIntentoMs(4)).toBe(1_800_000)
  })

  it('devuelve null al agotar los 5 intentos', () => {
    expect(proximoIntentoMs(MAX_INTENTOS)).toBeNull()
    expect(proximoIntentoMs(MAX_INTENTOS + 3)).toBeNull()
  })

  it('trata 0 intentos como si viniera el primero', () => {
    expect(proximoIntentoMs(0)).toBe(10_000)
  })
})

describe('esperaInmediata', () => {
  it('el salto de 10 segundos se hace en la misma invocación', () => {
    // Es lo que separa "el bot responde en 10s" de "responde en 15 minutos":
    // en Vercel free una app fría es el caso normal, no una anomalía.
    expect(esperaInmediata(1)).toBe(true)
  })

  it('los saltos de un minuto o más los maneja el ticker', () => {
    expect(esperaInmediata(2)).toBe(false)
    expect(esperaInmediata(3)).toBe(false)
    expect(esperaInmediata(4)).toBe(false)
  })

  it('un intento agotado nunca es inmediato', () => {
    expect(esperaInmediata(MAX_INTENTOS)).toBe(false)
  })
})
