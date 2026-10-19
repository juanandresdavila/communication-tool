/**
 * El `waitUntil` del self-host: el proceso vive, no hay runtime que corte la
 * request al responder, así que alcanza con no esperar la promesa. Pero una
 * promesa que rechaza sin dueño termina en `unhandledRejection`, y en Bun eso
 * puede tirar el proceso entero. Este adaptador es la red de seguridad: loguea
 * el rechazo y no lo deja suelto.
 *
 * No reemplaza el `.catch` de quien origina el trabajo: ese sabe qué significa
 * que su promesa falle (una entrega queda `pending` y la retoma el tick). Esto
 * solo cubre lo que se escape.
 */
export function crearWaitUntilSelfHost(
  log: (mensaje: string) => void,
): (promesa: Promise<unknown>) => void {
  return (promesa) => {
    promesa.catch((error: unknown) => {
      const mensaje = error instanceof Error ? error.message : String(error)
      log(`waitUntil: una promesa rechazó sin manejar: ${mensaje}`)
    })
  }
}
