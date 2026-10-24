import { describe, expect, it, vi } from 'vitest'
import { crearWaitUntilSelfHost } from './wait-until-self-host.js'

describe('crearWaitUntilSelfHost', () => {
  it('loguea un rechazo y no lo deja suelto', async () => {
    const log = vi.fn()

    crearWaitUntilSelfHost(log)(Promise.reject(new Error('se cayó')))
    await new Promise((r) => setTimeout(r, 0))

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('se cayó'))
  })

  it('no loguea nada si la promesa resuelve', async () => {
    const log = vi.fn()

    crearWaitUntilSelfHost(log)(Promise.resolve('listo'))
    await new Promise((r) => setTimeout(r, 0))

    expect(log).not.toHaveBeenCalled()
  })
})
