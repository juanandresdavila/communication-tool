import { Cron } from 'croner'

/**
 * La próxima ejecución de una expresión cron en una zona horaria, o null si
 * la expresión o la zona no sirven.
 *
 * Se delega en croner en vez de calcularlo a mano: los saltos de horario de
 * verano producen horas inexistentes y horas ambiguas, y una implementación
 * casera parece correcta durante años en una zona sin DST como Argentina.
 */
export function proximaEjecucion(
  expresion: string,
  zona: string,
  desde: Date,
): Date | null {
  if (!zonaValida(zona)) return null
  try {
    const proxima = new Cron(expresion, { timezone: zona }).nextRun(desde)
    return proxima ?? null
  } catch {
    // croner tira ante una expresión inválida. Devolver null deja que quien
    // llama decida: la ruta contesta 400 y el disparo marca el programado.
    return null
  }
}

export function cronValido(expresion: string): boolean {
  if (expresion.trim() === '') return false
  try {
    // Se pide la próxima ejecución además de construirlo: croner acepta
    // algunas expresiones que después no producen ninguna corrida.
    return new Cron(expresion).nextRun() !== null
  } catch {
    return false
  }
}

export function zonaValida(zona: string): boolean {
  if (zona.trim() === '') return false
  try {
    // La forma estándar de validar una zona IANA sin tabla propia: Intl tira
    // RangeError si no la conoce.
    new Intl.DateTimeFormat('en-US', { timeZone: zona })
    return true
  } catch {
    return false
  }
}
