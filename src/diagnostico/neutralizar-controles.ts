/**
 * Escapa los caracteres de control y de dirección antes de imprimir texto
 * guardado en un terminal.
 *
 * El texto de los mensajes lo controla quien escribe al bot: sin esto, una
 * secuencia ESC o un override bidi viaja hasta la pantalla de quien corre el
 * diagnóstico y puede reescribirla. Cada carácter se reemplaza por un escape
 * visible, `\u{1b}` para ESC (hex en minúscula, sin relleno).
 *
 * Rangos: C0 (incluye salto de línea y tab), DEL, C1, U+061C, U+200E, U+200F,
 * U+202A a U+202E y U+2066 a U+2069. U+200D (unión de emoji) queda como está.
 */

// La regla `no-control-regex` está prendida en `js.configs.recommended`, y acá
// los caracteres de control son justamente lo que se busca.
// eslint-disable-next-line no-control-regex
const CONTROLES = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g

export function neutralizarControles(texto: string): string {
  return texto.replace(
    CONTROLES,
    (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`,
  )
}
