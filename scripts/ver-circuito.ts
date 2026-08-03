/**
 * Diagnóstico de solo lectura: el estado de las tres colas del servicio.
 *
 * Es lo primero que conviene mirar cuando "un mensaje no llegó", antes de
 * tocar código. Ver también CLAUDE.md, §El corte: si los entrantes están en
 * cero y el servicio está sano, el problema suele ser el registro del webhook,
 * que vive en Telegram y no en el repo.
 *
 *     bun run scripts/ver-circuito.ts
 */
import { Client } from '@neondatabase/serverless'

const c = new Client(process.env.DATABASE_URL)
await c.connect()

const entrantes = await c.query(
  `SELECT provider_update_id AS update_id, left(text, 28) AS texto,
          delivery_status AS estado, delivery_attempts AS intentos,
          left(coalesce(last_error, ''), 28) AS error
   FROM inbound_messages ORDER BY received_at DESC LIMIT 8`,
)
console.log('ENTRANTES (los últimos 8):')
console.table(entrantes.rows)

const salientes = await c.query(
  `SELECT left(text, 32) AS texto, kind, status AS estado,
          provider_message_id AS tg, left(coalesce(error, ''), 28) AS error
   FROM outbound_messages ORDER BY created_at DESC LIMIT 8`,
)
console.log('SALIENTES (los últimos 8):')
console.table(salientes.rows)

const programados = await c.query(
  `SELECT s.name AS nombre, s.cron, s.timezone AS zona, s.next_run_at AS proximo,
          s.last_status AS ultimo,
          CASE WHEN a.schedule_callback_url IS NULL THEN 'SIN CALLBACK' ELSE 'ok' END
            AS callback
   FROM schedules s JOIN apps a ON a.id = s.app_id
   ORDER BY s.next_run_at`,
)
console.log('PROGRAMADOS:')
console.table(programados.rows)

// Un programado sin callback se marca `failed` sin postear nada, que es
// indistinguible de una app caída si no se mira esta columna.
const sinCallback = programados.rows.filter(
  (f) => (f as { callback: string }).callback === 'SIN CALLBACK',
)
if (sinCallback.length > 0) {
  console.log(
    `\nOJO: ${sinCallback.length} programado(s) de una app sin schedule_callback_url. No van a disparar.`,
  )
}

await c.end()
