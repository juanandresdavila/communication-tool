export interface OpcionesDePresupuesto {
  /** Respuestas permitidas por clave y por ventana. */
  porVentana: number
  /** Duración de la ventana, en milisegundos. */
  ventanaMs: number
  /** Máximo de claves vivas en memoria. */
  maxClaves: number
}

export interface PresupuestoDeRespuestas {
  /** Consume una unidad para `clave`. Devuelve false si ya no quedaba. */
  consumir(clave: string, ahora: Date): boolean
}

/**
 * Valores de producción. El 5 sale del flujo real de vinculación, que necesita
 * entre 2 y 4 mensajes (escribirle al bot, leer la pista, mandar el código,
 * quizás un typo). Ver el spec del 2026-09-20.
 */
export const PRESUPUESTO_POR_DEFECTO: OpcionesDePresupuesto = {
  porVentana: 5,
  ventanaMs: 60 * 60_000,
  maxClaves: 5_000,
}

interface Ventana {
  desde: number
  usadas: number
}

/**
 * Contador por clave con ventana FIJA: arranca con la primera unidad y al
 * cumplirse se descarta entera. Una ventana deslizante obligaría a guardar un
 * timestamp por respuesta en vez de un contador, y acá el objetivo es
 * amortiguar, no medir con precisión.
 *
 * 🚨 Cuenta por PROCESO. Es válido porque comm-tool es un container Bun de
 * proceso largo desde la migración al VPS; en un deploy serverless (el
 * rollback de Vercel) cada invocación arranca con el mapa vacío y esto degrada
 * a no limitar nada. Degrada, no rompe.
 */
export function crearPresupuesto(
  op: OpcionesDePresupuesto,
): PresupuestoDeRespuestas {
  const ventanas = new Map<string, Ventana>()

  function barrerVencidas(ahora: number): void {
    for (const [clave, v] of ventanas) {
      if (ahora - v.desde >= op.ventanaMs) ventanas.delete(clave)
    }
  }

  /**
   * Se busca el mínimo `desde` en vez de usar el orden de inserción del Map:
   * un `set` sobre una clave que ya existe conserva su posición original pero
   * le pone un `desde` nuevo, así que el orden de inserción NO es el orden de
   * antigüedad. Es O(n), pero solo corre al desbordar.
   */
  function expulsarMasVieja(): void {
    let candidata: string | undefined
    let masVieja = Infinity
    for (const [clave, v] of ventanas) {
      if (v.desde < masVieja) {
        masVieja = v.desde
        candidata = clave
      }
    }
    if (candidata !== undefined) ventanas.delete(candidata)
  }

  return {
    consumir(clave, ahora) {
      // Con presupuesto cero no hay nada que anotar. La guarda va acá arriba
      // porque si no, la primera llamada de cada clave se colaría por la rama
      // de ventana nueva, que no tiene contra qué comparar.
      if (op.porVentana < 1) return false

      const t = ahora.getTime()
      const actual = ventanas.get(clave)

      if (actual && t - actual.desde < op.ventanaMs) {
        if (actual.usadas >= op.porVentana) return false
        actual.usadas += 1
        return true
      }

      // Ventana nueva. Si la clave no estaba, el mapa va a crecer: hay que
      // hacerle lugar antes.
      if (!actual && ventanas.size >= op.maxClaves) {
        barrerVencidas(t)
        if (ventanas.size >= op.maxClaves) expulsarMasVieja()
      }

      ventanas.set(clave, { desde: t, usadas: 1 })
      return true
    },
  }
}
