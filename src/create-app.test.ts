import { describe, expect, it } from 'vitest'
import { createApp } from './create-app.js'
import { createFakeDeps } from './test-support/fake-deps.js'

describe('createApp', () => {
  it('POST /internal/tick sin Authorization da 401 con la app compuesta', async () => {
    const res = await createApp(createFakeDeps()).request('/internal/tick', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })
})
