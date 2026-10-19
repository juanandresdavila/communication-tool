import type { AppsRepo, BotsRepo } from './db/ports.js'
import { motivoSecretoInvalido } from './secrets.js'

export interface RevisionDeSecretosDeps {
  apps: Pick<AppsRepo, 'listarActivas'>
  bots: Pick<BotsRepo, 'listarActivos'>
  entorno: Record<string, string | undefined>
  log: (mensaje: string) => void
}

/**
 * Revisa al arrancar que los secretos que la base referencia por nombre
 * existan y sirvan, y avisa de los que no. Solo nombra la variable y el
 * motivo, nunca el valor. No tira: un problema de base no tiene que impedir
 * que el servicio arranque.
 */
export async function revisarSecretosReferenciados(
  deps: RevisionDeSecretosDeps,
): Promise<string[]> {
  try {
    const [apps, bots] = await Promise.all([
      deps.apps.listarActivas(),
      deps.bots.listarActivos(),
    ])

    const referencias: { nombre: string; de: string }[] = [
      ...apps.map((a) => ({
        nombre: a.deliverySecretEnv,
        de: `app ${a.slug}`,
      })),
      ...bots.flatMap((b) => [
        { nombre: b.tokenEnv, de: `bot ${b.slug}` },
        { nombre: b.webhookSecretEnv, de: `bot ${b.slug}` },
      ]),
    ]

    const problemas: string[] = []
    for (const { nombre, de } of referencias) {
      const valor = deps.entorno[nombre]
      const motivo =
        valor === undefined || valor === ''
          ? 'falta'
          : motivoSecretoInvalido(valor)
      if (motivo !== null) problemas.push(`${nombre} (${de}): ${motivo}`)
    }

    for (const problema of problemas) deps.log(problema)
    return problemas
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error)
    deps.log(`no se pudo revisar los secretos al arrancar: ${mensaje}`)
    return []
  }
}
