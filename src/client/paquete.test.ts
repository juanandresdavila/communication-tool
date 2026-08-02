import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// import.meta.dir no existe cuando Vitest carga el módulo. Ver CLAUDE.md.
const DIR = dirname(fileURLToPath(import.meta.url))

async function archivosDelCliente(): Promise<string[]> {
  const entradas = await readdir(DIR)
  return entradas.filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
}

/**
 * Los comentarios se sacan ANTES de buscar imports: sin esto, el ejemplo de
 * uso del JSDoc de `conformance.ts` se lee como un import de verdad y el test
 * falla contra su propia documentación.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('el paquete cliente es delgado', () => {
  it('no importa nada del servicio ni de node_modules', async () => {
    // Si esto se rompe, GymTracker se lleva medio comm-tool en su
    // node_modules y la migración deja de ser barata. Solo se permiten
    // imports relativos dentro de src/client y módulos node: nativos.
    const archivos = await archivosDelCliente()
    expect(archivos.length).toBeGreaterThan(3)

    for (const archivo of archivos) {
      const codigo = sinComentarios(await readFile(join(DIR, archivo), 'utf8'))
      const imports = [...codigo.matchAll(/from '([^']+)'/g)].map((m) => m[1])

      for (const modulo of imports) {
        const permitido =
          modulo?.startsWith('./') === true || modulo?.startsWith('node:') === true
        expect(
          permitido,
          `${archivo} importa "${modulo}", que no está permitido en el paquete`,
        ).toBe(true)
      }
    }
  })
})
