import { waitUntil } from '@vercel/functions'
// El `import type { Hono }` y la anotación NO son decorativos: el preset de
// Hono de Vercel rechaza cualquier entrypoint que no importe hono.
// Ver CLAUDE.md, §Gotchas del tooling.
import type { Hono } from 'hono'
import { wireApp } from './wire.js'

// waitUntil se inyecta en vez de importarse donde se usa: es lo único
// atado a Vercel en todo el servicio. El entrypoint self-host (server.ts)
// lo reemplaza por `(p) => { void p }` sin tocar una línea de dominio.
const wired = wireApp((promesa) => {
  waitUntil(promesa)
})

const app: Hono = wired.app

// El default export es lo que consume Vercel.
export default app
