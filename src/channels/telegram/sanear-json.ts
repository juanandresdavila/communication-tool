/**
 * Limpia un JSON que llegó de Telegram antes de guardarlo.
 *
 * Dos cosas rompen a Postgres con un texto que Telegram sí deja pasar:
 * - U+0000: ni `text` ni `jsonb` lo aceptan (el INSERT tira y el webhook da 500,
 *   y Telegram reintenta el mismo update para siempre).
 * - Un surrogate suelto (`'a\ud800b'`): al codificar a UTF-8 el driver lo
 *   convierte mal y se pierde lo que sigue.
 *
 * En cada string, y en cada clave de objeto, `toWellFormed()` cambia el
 * surrogate suelto por U+FFFD y después el U+0000 se reemplaza por U+FFFD
 * también. Los pares válidos (emoji, U+200D) no se tocan. No muta la entrada.
 */
const REEMPLAZO = '�'

function sanearTexto(texto: string): string {
  return texto.toWellFormed().replaceAll('\u0000', REEMPLAZO)
}

export function sanearJson(valor: unknown): unknown {
  if (typeof valor === 'string') return sanearTexto(valor)
  if (Array.isArray(valor)) return valor.map(sanearJson)
  if (valor !== null && typeof valor === 'object') {
    // fromEntries define propiedades propias: una clave `__proto__` que venga
    // del JSON queda como dato y no toca el prototipo.
    return Object.fromEntries(
      Object.entries(valor).map(([clave, v]) => [
        sanearTexto(clave),
        sanearJson(v),
      ]),
    )
  }
  return valor
}
