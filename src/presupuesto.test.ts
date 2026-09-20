import { describe, expect, it } from 'vitest'
import { crearPresupuesto } from './presupuesto.js'

const T0 = new Date('2026-09-20T12:00:00.000Z')

/** Azúcar para no escribir `new Date(T0.getTime() + n)` en cada línea. */
function enT(ms: number): Date {
  return new Date(T0.getTime() + ms)
}

describe('crearPresupuesto', () => {
  it('deja pasar hasta el tope y después no', () => {
    const p = crearPresupuesto({
      porVentana: 2,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('a', T0)).toBe(true)
    expect(p.consumir('a', enT(1))).toBe(true)
    expect(p.consumir('a', enT(2))).toBe(false)
  })

  it('cuenta cada clave por separado', () => {
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('bot-1:111', T0)).toBe(true)
    expect(p.consumir('bot-1:222', T0)).toBe(true)
    expect(p.consumir('bot-1:111', T0)).toBe(false)
  })

  it('renueva la ventana al cumplirse, no antes', () => {
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('a', T0)).toBe(true)
    expect(p.consumir('a', enT(59_999))).toBe(false)
    expect(p.consumir('a', enT(60_000))).toBe(true)
  })

  it('con presupuesto cero no deja pasar ni la primera', () => {
    // La rama de "ventana nueva" es la que se cuela si no hay guarda arriba:
    // la primera llamada de cada clave no encuentra ventana previa contra la
    // cual comparar el contador.
    const p = crearPresupuesto({
      porVentana: 0,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('a', T0)).toBe(false)
  })

  it('no crece más allá del tope de claves', () => {
    // El tope es lo que impide que el propio limitador sea el memory leak:
    // sin él, cambiar el chat id en cada mensaje llena la RAM en vez de la
    // base, que es peor que el problema que se quiere resolver.
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 3_600_000,
      maxClaves: 2,
    })

    expect(p.consumir('a', T0)).toBe(true)
    expect(p.consumir('b', enT(1))).toBe(true)
    // Entra 'c' con el mapa lleno y ninguna vencida: se expulsa la más vieja.
    expect(p.consumir('c', enT(2))).toBe(true)

    // 'a' fue expulsada y arranca de cero. Perder el contador de la clave más
    // vieja es el precio de acotar la RAM, y es el precio correcto.
    expect(p.consumir('a', enT(3))).toBe(true)
    // 'c' sigue viva y ya gastó lo suyo.
    expect(p.consumir('c', enT(4))).toBe(false)
  })

  it('reutiliza el lugar de una clave vencida antes de expulsar una viva', () => {
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 60_000,
      maxClaves: 2,
    })

    expect(p.consumir('vieja', T0)).toBe(true)
    expect(p.consumir('viva', enT(59_000))).toBe(true)
    // 'vieja' ya venció, así que la barrida le hace lugar a 'nueva' sin tocar
    // a 'viva'.
    expect(p.consumir('nueva', enT(61_000))).toBe(true)
    expect(p.consumir('viva', enT(61_001))).toBe(false)
  })
})
