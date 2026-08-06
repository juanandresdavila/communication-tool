import { wireApp } from './wire.js'

// Self-host: el proceso vive, no hay runtime que corte la request al
// responder — un fire-and-forget alcanza. Es el reemplazo documentado del
// waitUntil de Vercel (ver el comentario en wire.ts / index.ts).
const { app, sql } = wireApp((promesa) => {
  void promesa
})

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
})

console.log(`comm-tool escuchando en :${server.port}`)

async function apagar(senal: string) {
  console.log(`${senal}: cerrando...`)
  await server.stop()
  await sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGTERM', () => void apagar('SIGTERM'))
process.on('SIGINT', () => void apagar('SIGINT'))
