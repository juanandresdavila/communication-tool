import { createApp } from './app'
import { createDb } from './db/client'
import { parseEnv } from './env'

// Único lugar del servicio que lee process.env.
const env = parseEnv(process.env)

const app = createApp({ db: createDb(env.DATABASE_URL) })

// El default export es lo que consumen tanto Vercel como Bun.
export default app
