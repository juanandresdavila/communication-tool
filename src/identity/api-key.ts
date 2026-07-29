import { createHash } from 'node:crypto'

/**
 * La base guarda el hash, no la clave. Un hash no es un secreto: si se filtra
 * la base, no se puede reconstruir la clave con la que autenticar.
 *
 * SHA-256 sin salt es correcto acá y no lo sería para contraseñas: la clave la
 * genera el sistema con 32 bytes de entropía, no un humano, así que no hay
 * diccionario que atacar y no hace falta un KDF lento.
 */
export function hashApiKey(clave: string): string {
  return createHash('sha256').update(clave, 'utf8').digest('hex')
}

export function formatApiKey(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `ct_${hex}`
}
