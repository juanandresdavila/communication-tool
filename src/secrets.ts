export type SecretReader = (nombreVariable: string) => string

/**
 * Largo mínimo de cualquier secreto. `openssl rand -hex 32` da 64 caracteres;
 * 32 deja pasar los generadores más cortos pero no un valor cualquiera.
 */
export const LARGO_MINIMO_SECRETO = 32

/**
 * Devuelve por qué un valor no sirve como secreto, o `null` si sirve. El
 * motivo nunca incluye el valor: va a logs y a mensajes de error. Los chequeos
 * van en orden y el primero que aplica gana.
 */
export function motivoSecretoInvalido(valor: string): string | null {
  // Vercel reemplaza por `[SENSITIVE]` las variables marcadas como sensibles
  // al hacer `vercel env pull`: queda un valor que parece un secreto y no lo es.
  if (valor.includes('[SENSITIVE]')) {
    return 'contiene el marcador SENSITIVE de Vercel'
  }
  if (/^["'[]|["'\]]$/.test(valor)) {
    return 'empieza o termina con comillas o corchetes'
  }
  // `\s` incluye `\r` y `\n`: un .env editado en Windows deja el `\r` pegado.
  if (/^\s|\s$/.test(valor)) {
    return 'tiene espacios al principio o al final'
  }
  if (valor.length < LARGO_MINIMO_SECRETO) {
    return `tiene menos de ${LARGO_MINIMO_SECRETO} caracteres`
  }
  return null
}

/**
 * La base guarda el NOMBRE de la variable de entorno, nunca su valor. Así no
 * hace falta cifrado en reposo y mudar el servicio de host es copiar un .env.
 */
export function createSecretReader(
  entorno: Record<string, string | undefined>,
): SecretReader {
  return (nombreVariable) => {
    const valor = entorno[nombreVariable]
    if (valor === undefined || valor === '') {
      throw new Error(
        `Falta la variable de entorno ${nombreVariable}, referenciada desde la base`,
      )
    }
    const motivo = motivoSecretoInvalido(valor)
    if (motivo !== null) {
      throw new Error(
        `La variable de entorno ${nombreVariable}, referenciada desde la base, no sirve: ${motivo}`,
      )
    }
    return valor
  }
}
