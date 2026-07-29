export type SecretReader = (nombreVariable: string) => string

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
    return valor
  }
}
