/**
 * 31 caracteres: los 36 alfanuméricos menos 0, O, 1, I y L, que se confunden
 * al leer un código en voz alta o al transcribirlo desde una pantalla.
 */
export const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export const LARGO_CODIGO = 6

/**
 * Mayor múltiplo de 31 que entra en un byte. Los bytes por encima se
 * descartan: sin esto, `byte % 31` haría más probables a los primeros ocho
 * caracteres del alfabeto.
 */
const CORTE_SIN_SESGO = 248

export function generateLinkCode(bytes: Uint8Array): string {
  let code = ''
  for (const byte of bytes) {
    if (byte >= CORTE_SIN_SESGO) continue
    code += ALFABETO[byte % ALFABETO.length]
    if (code.length === LARGO_CODIGO) return code
  }
  throw new Error(
    `Bytes insuficientes para generar un código de ${LARGO_CODIGO} caracteres`,
  )
}

/**
 * Solo normaliza forma: mayúsculas y separadores. NO corrige caracteres
 * ambiguos. La mitigación de la ambigüedad es que el alfabeto no los contiene;
 * mapear una O tipeada a otra letra generaría un código válido pero distinto
 * del emitido, que es peor que rechazarlo.
 */
export function normalizeLinkCode(entrada: string): string | null {
  const limpio = entrada.trim().toUpperCase().replace(/[\s-]/g, '')

  if (limpio.length !== LARGO_CODIGO) return null
  if (![...limpio].every((c) => ALFABETO.includes(c))) return null
  return limpio
}
