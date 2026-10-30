import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// server.ts es el entrypoint del self-host: arranca con Bun.serve al
// importarlo, así que no se puede cargar desde Vitest. Se lo corre como
// proceso, igual que en producción, y se mira lo que deja en los logs.

// Nadie escucha en el puerto 1: la base rechaza al toque y no hace falta una.
const BASE_QUE_RECHAZA = 'postgres://comm:comm@127.0.0.1:1/comm'
const SECRETO = 'a1'.repeat(32)

function arrancarServidor(databaseUrl = BASE_QUE_RECHAZA) {
  // --no-env-file: Bun lee el .env del directorio solo, y el de un checkout
  // local puede tener secretos de verdad. El test usa solo lo que se le pasa.
  const proceso = spawn('bun', ['--no-env-file', 'src/server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: databaseUrl,
      INTERNAL_SECRET: SECRETO,
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let salida = ''
  let errores = ''
  proceso.stdout.setEncoding('utf8').on('data', (d: string) => (salida += d))
  proceso.stderr.setEncoding('utf8').on('data', (d: string) => (errores += d))

  return {
    salida: () => salida,
    errores: () => errores,
    async esperar(condicion: () => boolean, ms: number): Promise<void> {
      const limite = Date.now() + ms
      while (!condicion()) {
        if (Date.now() > limite || proceso.exitCode !== null) {
          throw new Error(
            `no pasó lo esperado (exit ${proceso.exitCode}). stdout: ${salida} stderr: ${errores}`,
          )
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    },
    async terminar(senal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
      if (proceso.exitCode !== null) return
      const salio = new Promise((r) => proceso.once('exit', r))
      proceso.kill(senal)
      const tardo = setTimeout(() => proceso.kill('SIGKILL'), 5_000)
      await salio
      clearTimeout(tardo)
    },
  }
}

describe('server.ts', () => {
  it('al arrancar revisa los secretos que nombra la base y avisa por log', async () => {
    const servidor = arrancarServidor()
    try {
      // Con la base caída la revisión no puede leer apps ni bots: el aviso
      // que queda es ese. Alcanza para saber que server.ts la llamó y que el
      // log de wire.ts llega a la consola.
      await servidor.esperar(
        () =>
          servidor
            .errores()
            .includes('no se pudo revisar los secretos al arrancar'),
        10_000,
      )
      expect(servidor.salida()).toMatch(/comm-tool escuchando en :\d+/)
    } finally {
      await servidor.terminar()
    }
  }, 15_000)

  it('una base que no contesta no frena el arranque', async () => {
    // Acepta la conexión y no contesta nunca: la revisión queda esperando.
    const sockets: Socket[] = []
    const base = createServer((s) => sockets.push(s))
    await new Promise<void>((r) => base.listen(0, '127.0.0.1', r))
    const { port } = base.address() as { port: number }

    const servidor = arrancarServidor(
      `postgres://comm:comm@127.0.0.1:${port}/comm`,
    )
    try {
      await servidor.esperar(
        () =>
          servidor.salida().includes('comm-tool escuchando en :') &&
          sockets.length > 0,
        5_000,
      )
      // Escucha con la revisión ya colgada en la base: no la esperó.
      expect(servidor.errores()).not.toContain('no se pudo revisar')
    } finally {
      // SIGKILL: con la consulta colgada, el apagado prolijo esperaría los 5 s
      // de `sql.end`, y acá no se mide el apagado.
      await servidor.terminar('SIGKILL')
      for (const s of sockets) s.destroy()
      base.close()
    }
  }, 15_000)
})
