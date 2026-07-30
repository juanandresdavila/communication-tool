// Zod 4 se importa como namespace. `import { z } from 'zod'` resuelve a
// undefined bajo Vitest según qué entry point del paquete se elija.
import * as z from 'zod'

/**
 * Lo único que necesita hablar con la base. Va aparte del entorno completo
 * porque el runner de migraciones no atiende requests: pedirle el secreto del
 * ticker haría fallar `bun run db:migrate` en cualquier entorno que solo tenga
 * la cadena de conexión.
 */
const databaseSchema = z.object({
  DATABASE_URL: z.string().min(1, 'es obligatoria'),
})

const envSchema = databaseSchema.extend({
  INTERNAL_SECRET: z.string().min(1, 'es obligatoria'),
})

export type DatabaseEnv = z.infer<typeof databaseSchema>
export type Env = z.infer<typeof envSchema>

function parseCon<T extends z.ZodType>(
  schema: T,
  raw: Record<string, string | undefined>,
): z.infer<T> {
  const resultado = schema.safeParse(raw)
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Configuración inválida — ${detalle}`)
  }
  return resultado.data
}

export function parseEnv(raw: Record<string, string | undefined>): Env {
  return parseCon(envSchema, raw)
}

export function parseDatabaseEnv(
  raw: Record<string, string | undefined>,
): DatabaseEnv {
  return parseCon(databaseSchema, raw)
}
