export const MAX_INTENTOS = 5

/** Espera después del intento N, en milisegundos. */
const ESCALERA = [10_000, 60_000, 300_000, 1_800_000] as const

/** Hasta acá el reintento se hace sin salir de la invocación. */
const UMBRAL_INMEDIATO_MS = 10_000

/**
 * Cuánto falta para el próximo intento, donde `intentosHechos` **incluye el
 * que acaba de fallar**. Devuelve null cuando ya no hay que reintentar.
 *
 * Que el parámetro incluya el intento actual es lo que hace que el total sea
 * 5 sin importar quién llame: el webhook hace dos seguidos y el ticker el
 * resto, pero los dos suman sobre el mismo contador persistido.
 */
export function proximoIntentoMs(intentosHechos: number): number | null {
  if (intentosHechos >= MAX_INTENTOS) return null
  return ESCALERA[Math.max(0, intentosHechos - 1)] ?? null
}

/**
 * Si el próximo intento entra en la misma invocación. Solo el salto de 10
 * segundos: bloquear la función 30 minutos sería absurdo y carísimo.
 */
export function esperaInmediata(intentosHechos: number): boolean {
  const espera = proximoIntentoMs(intentosHechos)
  return espera !== null && espera <= UMBRAL_INMEDIATO_MS
}
