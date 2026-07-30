// Zod 4 se importa como namespace. `import { z } from 'zod'` resuelve a
// undefined bajo Vitest según qué entry point del paquete se elija.
import * as z from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'es obligatoria'),
  INTERNAL_SECRET: z.string().min(1, 'es obligatoria'),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const resultado = envSchema.safeParse(raw)
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Configuración inválida — ${detalle}`)
  }
  return resultado.data
}
