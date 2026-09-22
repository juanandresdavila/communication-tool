import { Buffer } from 'node:buffer'
import * as z from 'zod'

/** Bot API, `InlineKeyboardButton.callback_data`: «1-64 bytes». Bytes, no caracteres. */
export const MAX_BYTES_DATA = 64

/**
 * Tope propio. La Bot API no publica un límite de botones por mensaje (buscado
 * el 22/09/2026 en la doc de la 10.3), y un teclado más grande ya no se usa en
 * un teléfono.
 */
export const MAX_BOTONES = 100

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function esHttps(u: string): boolean {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

const botonSchema = z
  .object({
    text: z.string().min(1),
    data: z.string().optional(),
    url: z.string().optional(),
  })
  .refine(
    (b) => (b.data === undefined) !== (b.url === undefined),
    'exactamente uno de data o url',
  )
  .refine(
    (b) =>
      b.data === undefined ||
      (bytes(b.data) >= 1 && bytes(b.data) <= MAX_BYTES_DATA),
    `data de 1 a ${MAX_BYTES_DATA} bytes`,
  )
  .refine((b) => b.url === undefined || esHttps(b.url), 'url https')

/**
 * Valida en la ruta lo que Telegram rechazaría con un 400: así la app recibe
 * un 400 con causa en vez de un 502 que parece del proveedor.
 */
export const botonesSchema = z
  .array(z.array(botonSchema).min(1))
  .min(1)
  .refine(
    (filas) => filas.reduce((n, fila) => n + fila.length, 0) <= MAX_BOTONES,
    `como mucho ${MAX_BOTONES} botones`,
  )
