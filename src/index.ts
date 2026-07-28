import { createApp } from './app.js'
import { createDb } from './db/client.js'
import { parseEnv } from './env.js'

// Único lugar del servicio que lee process.env.
const env = parseEnv(process.env)

const app = createApp({ db: createDb(env.DATABASE_URL) })

// El default export es lo que consumen tanto Vercel como Bun.
export default app
