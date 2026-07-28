import type { Db } from '../db/client.js'

export interface FakeDb extends Db {
  pings: number
}

export function createFakeDb(options: { pingFalla?: boolean } = {}): FakeDb {
  const fake: FakeDb = {
    pings: 0,
    async ping() {
      fake.pings += 1
      if (options.pingFalla) throw new Error('base caída')
    },
  }
  return fake
}
