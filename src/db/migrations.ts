const NOMBRE_VALIDO = /^\d{4}_[a-z0-9_]+\.sql$/

export function assertValidMigrationName(nombre: string): void {
  if (!NOMBRE_VALIDO.test(nombre)) {
    throw new Error(
      `Nombre de migración inválido: "${nombre}". Se espera NNNN_snake_case.sql`,
    )
  }
}

export function sortMigrationNames(nombres: string[]): string[] {
  nombres.forEach(assertValidMigrationName)
  // El prefijo de 4 dígitos con ceros a la izquierda hace que el orden
  // lexicográfico coincida con el numérico.
  return [...nombres].sort()
}

export function pendingMigrations(
  enDisco: string[],
  aplicadas: string[],
): string[] {
  const ordenadas = sortMigrationNames(enDisco)
  const yaAplicadas = new Set(aplicadas)

  const fantasmas = aplicadas.filter((a) => !ordenadas.includes(a))
  if (fantasmas.length > 0) {
    throw new Error(
      `La base tiene migraciones que no están en disco: ${fantasmas.join(', ')}. ` +
        'El checkout está desactualizado o se borró un archivo.',
    )
  }

  const pendientes = ordenadas.filter((n) => !yaAplicadas.has(n))
  const ultimaAplicada = ordenadas.filter((n) => yaAplicadas.has(n)).at(-1)

  if (ultimaAplicada !== undefined) {
    const fueraDeOrden = pendientes.filter((n) => n < ultimaAplicada)
    if (fueraDeOrden.length > 0) {
      throw new Error(
        `Migraciones fuera de orden: ${fueraDeOrden.join(', ')} son anteriores ` +
          `a ${ultimaAplicada}, que ya está aplicada. Renumerá antes de seguir.`,
      )
    }
  }

  return pendientes
}
