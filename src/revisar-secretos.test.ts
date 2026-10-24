import { describe, expect, it, vi } from 'vitest'
import { revisarSecretosReferenciados } from './revisar-secretos.js'
import { unApp, unBot } from './test-support/fake-repos.js'

const BUENO = 'a1'.repeat(32) // 64 caracteres, la forma de `openssl rand -hex 32`
const FILTRABLE = 'zqx'.repeat(4) // 12 caracteres: si aparece en un mensaje, se filtró

const app = unApp({ slug: 'demo', deliverySecretEnv: 'DELIVERY_SECRET_DEMO' })
const bot = unBot({
  slug: 'demo',
  tokenEnv: 'TOKEN_DEMO',
  webhookSecretEnv: 'WEBHOOK_SECRET_DEMO',
})

function armar(entorno: Record<string, string | undefined>) {
  const log = vi.fn<(mensaje: string) => void>()
  return {
    log,
    revisar: () =>
      revisarSecretosReferenciados({
        apps: { listarActivas: async () => [app] },
        bots: { listarActivos: async () => [bot] },
        entorno,
        log,
      }),
  }
}

describe('revisarSecretosReferenciados', () => {
  it('nombra el secreto que falta, y nada más', async () => {
    const { revisar, log } = armar({
      TOKEN_DEMO: BUENO,
      WEBHOOK_SECRET_DEMO: BUENO,
    })

    expect(await revisar()).toEqual(['DELIVERY_SECRET_DEMO (app demo): falta'])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('nombra el que no cumple la regla, sin el valor', async () => {
    const { revisar, log } = armar({
      DELIVERY_SECRET_DEMO: BUENO,
      TOKEN_DEMO: BUENO,
      WEBHOOK_SECRET_DEMO: FILTRABLE,
    })

    const problemas = await revisar()

    expect(problemas).toContain(
      'WEBHOOK_SECRET_DEMO (bot demo): tiene menos de 32 caracteres',
    )
    const logueado = log.mock.calls.map((c) => c[0]).join('\n')
    expect(logueado).not.toContain('zqx')
  })

  it('trata una variable vacía como faltante', async () => {
    const { revisar } = armar({
      DELIVERY_SECRET_DEMO: BUENO,
      TOKEN_DEMO: '',
      WEBHOOK_SECRET_DEMO: BUENO,
    })

    expect(await revisar()).toEqual(['TOKEN_DEMO (bot demo): falta'])
  })

  it('no dice nada si todo sirve', async () => {
    const { revisar, log } = armar({
      DELIVERY_SECRET_DEMO: BUENO,
      TOKEN_DEMO: BUENO,
      WEBHOOK_SECRET_DEMO: BUENO,
    })

    expect(await revisar()).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })

  it('si la base no contesta, loguea y no tira', async () => {
    const log = vi.fn<(mensaje: string) => void>()

    await expect(
      revisarSecretosReferenciados({
        apps: {
          listarActivas: async () => {
            throw new Error('conexión rechazada')
          },
        },
        bots: { listarActivos: async () => [bot] },
        entorno: {},
        log,
      }),
    ).resolves.toEqual([])

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('no se pudo revisar los secretos al arrancar:'),
    )
  })
})
