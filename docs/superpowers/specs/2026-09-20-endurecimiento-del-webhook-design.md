# Endurecimiento del webhook de Telegram

**Fecha:** 2026-09-20
**Estado:** diseño, pendiente de aprobación
**Alcance:** communication-tool. No toca ningún consumidor ni ningún contrato
público. Sin migración.

## Problema

comm-tool no tiene rate limit en ningún endpoint (grep de
`rateLimit|rate_limit|429|throttle` sobre `src`: cero resultados), y el bot de
Telegram es un endpoint público de escritura al que le puede escribir cualquiera
del planeta con sólo saber su `@`. Los nombres siguen un patrón adivinable: ya
existe `@serverstatusjaddbot`.

**Esto es preventivo, no es respuesta a un incidente.** Medido el 20/09/2026
sobre la base `commtool` del container `comm-tool-db`: `inbound_messages` tiene
**65 filas del 03/08 al 16/09**, 64 de un chat vinculado y **una sola** de un
chat sin vincular, que fue una prueba propia. El día más cargado tiene 9. Nadie
encontró el bot todavía.

## Lo medido, y dos mediciones que miden otra cosa

### El peso de la tabla no es el costo marginal

128 kB para 65 filas da 1,97 kB por fila, y ese número invita a extrapolar. No
sirve: es **piso fijo**. Los componentes son páginas mínimas de heap, del índice
`UNIQUE (bot_id, provider_update_id)`, del índice parcial de pendientes, y de la
tabla TOAST del `jsonb`, que existe aunque esté vacía.

Medido acá sobre un update representativo:

| Qué | Bytes |
|---|---|
| Update típico de Telegram, JSON completo | 328 |
| Su campo `text` | 18 |
| Update con el texto máximo que admite Telegram (4096 caracteres) | 4406 |

Con overhead de fila y la entrada del índice único, **el costo marginal real es
de ~500 bytes por mensaje**, no 2 kB. O sea: **1 GB son ~2 millones de
mensajes**. El disco no es la amenaza, y eso baja la prioridad de todo lo que
apunte al disco.

Para confirmarlo contra producción, separando heap de total:

```sql
SELECT pg_size_pretty(pg_relation_size('inbound_messages'))        AS heap,
       pg_size_pretty(pg_total_relation_size('inbound_messages'))  AS total,
       pg_size_pretty(avg(pg_column_size(raw))::bigint)            AS raw_promedio
FROM inbound_messages;
```

### El volumen no acota el daño, porque el daño no necesita volumen

Ver «El camino del desconocido», más abajo. Un webhook lento degrada al usuario
real con un puñado de mensajes, no con miles.

## Las tres puertas, y por qué no cuestan lo mismo

### Puerta 1: `POST /webhooks/telegram/:botSlug` sin el secreto

Cuesta un `SELECT` indexado por slug y un 401. Es carga a la base sin
autenticar, pero es la puerta barata.

🚨 **La consulta a `bots` NO se puede mover después de validar el secreto**, y
cualquier plan que lo proponga está mal: el secreto es *por bot*
(`bot.webhookSecretEnv`), así que sin la fila no hay contra qué comparar.

### Puerta 2: escribirle al bot por Telegram

No necesita ningún secreto. Cada mensaje de un desconocido inserta una fila con
el JSON crudo entero y dispara una respuesta (`bot.unlinkedMessage`). Es la cara
de verdad.

### Puerta 3: `/vincular` desde un chat desconocido

No estaba en el análisis original. `/vincular` se atiende **antes** del
`insertIfNew` y antes de buscar el contacto, así que:

- no inserta ninguna fila y **el dedupe por `(bot_id, provider_update_id)` no lo
  cubre**;
- hace dos consultas a la base;
- contesta, también de forma síncrona.

Como fuerza bruta contra códigos **no preocupa, y queda descartado**: el
alfabeto tiene 31 caracteres y el código 6, o sea 31^6 = 887.503.681
combinaciones (~29,7 bits), de un solo uso, con TTL de 15 minutos por defecto y
atados a una app. A la velocidad a la que Telegram deja mandar mensajes, ese
espacio no se recorre.

Lo que sí importa de esta puerta: **la amplificación no puede llegar a cero
mientras `/vincular` siga contestando, y tiene que seguir contestando.** Ése es
el argumento de por qué no alcanza con dejar de guardar el crudo.

## El camino del desconocido es más caro que el del usuario real

En `src/routes/telegram-webhook.ts`:

```ts
if (!contacto) {
  await responder(bot.unlinkedMessage)   // espera a api.telegram.org
  return c.json({ ok: true })
}
deps.waitUntil(entregarConReintentoInmediato(deps, guardado))  // no espera
return c.json({ ok: true })
```

El mensaje de un contacto vinculado contesta 200 al toque y entrega después. El
de un desconocido **retiene el request hasta que api.telegram.org responde**. Y
`createTelegramClient` **no tiene timeout**: su `fetch` no lleva `AbortSignal`,
al revés que `createDeliveryClient`, que sí usa `AbortSignal.timeout(...)` con
`TIMEOUT_ENTREGA_MS = 10_000`.

Telegram entrega webhooks con un pool acotado (`max_connections`, 40 por
defecto) y frena si el webhook va lento. El daño barato entonces no es el disco
ni la cuota saliente del bot: es **head-of-line blocking**. Los mensajes de
desconocidos ocupan slots esperando a Telegram y los del usuario real hacen cola
atrás. No hace falta volumen para eso, hace falta que api.telegram.org esté
lento.

**Éste es el problema que este spec resuelve primero.**

## La invariante del crudo no se pisa: se acota a donde su razón se cumple

El comentario del webhook dice textual:

> El crudo se persiste SIEMPRE y antes de cualquier otra cosa: si el parser de
> la app o la entrega fallan, el dato no se pierde.

Es una decisión deliberada y su justificación es **enteramente sobre el camino
de entrega**. Para un chat no vinculado la fila nace en `skipped`: no hay parser
de app y no hay entrega. Verificado sobre el código, no supuesto:

- el único lector de `inbound_messages.raw` en todo el servicio es
  `cuerpoDeEntrega`, en `src/delivery/deliver.ts`;
- `reencolar` es `WHERE id = $1 AND delivery_status = 'failed'`, así que una
  fila `skipped` **no puede volver a `pending` nunca**;
- el índice parcial del ticker es `WHERE delivery_status = 'pending'`, así que
  las `skipped` ni figuran ahí.

El `raw` de una fila `skipped` es **dato de solo escritura**: ningún camino lo
lee jamás. Guardar `'null'::jsonb` en esas filas no rompe la invariante,
la restringe al conjunto donde su razón aplica. No necesita migración: `'null'`
es un valor `jsonb` válido y distinto de SQL `NULL`, así que la columna sigue
cumpliendo su `NOT NULL`.

**Lo que sí se conserva es la fila.** Esas filas son la única telemetría de que
alguien encontró el bot: la conclusión «nadie lo encontró» del 20/09 se dedujo
justamente de ellas. Borrarlas sería apagar el detector antes de necesitarlo.

## Qué se construye

Cuatro cambios, un solo PR, sin migración y sin paso de ops.

### 1. La respuesta al no vinculado sale del camino síncrono

Las dos respuestas que el webhook origina por su cuenta (`bot.unlinkedMessage` y
la de `/vincular`) pasan por `deps.waitUntil`, igual que ya pasa la entrega. El
200 a Telegram deja de esperar a api.telegram.org.

🚨 **La trampa, y es la razón por la que este cambio necesita su propio test:**
`sendMessage` **tira** cuando Telegram rechaza, y el `waitUntil` de `server.ts`
es `(promesa) => { void promesa }`. `void` no captura rejections. Movido tal
cual, cada respuesta fallida deja una unhandled rejection. La promesa se envuelve
en un `.catch` explícito en el sitio donde se programa, no en `waitUntil`: quien
origina el trabajo es quien sabe qué significa que falle.

Cambia el orden de dos efectos que hoy están acoplados: `/vincular` hoy espera a
que la respuesta salga antes de devolver 200. Después del cambio no. No afecta la
corrección, porque la vinculación ya ocurrió en la base antes del envío, y un
reintento de Telegram sobre el mismo update cae en la rama «Ya estabas
vinculado».

### 2. Timeout en el cliente de Telegram

`createTelegramClient` pasa a usar `AbortSignal.timeout(...)`, con el mismo
patrón que `createDeliveryClient`. La constante vive dentro del módulo, como
`TIMEOUT_ENTREGA_MS`: **la interfaz `TelegramClient` no cambia**, así que ningún
sitio de llamada ni el doble de los tests se tocan.

Alcanza también al saliente de `/v1/messages`, y ahí compone bien: `enviarSaliente`
ya envuelve `sendMessage` en `try/catch`, un timeout se vuelve `send_failed`, y
una fila `failed` se puede volver a reservar con la misma clave de idempotencia.
Hoy un api.telegram.org colgado deja el saliente colgado sin marcar.

### 3. Presupuesto de respuestas por chat, en memoria

**Un contador acotado en memoria del proceso** que limita cuántas respuestas
origina el webhook hacia un mismo chat en una ventana.

🚨 **Esto es viable hoy y no lo era antes.** comm-tool es un container Bun de
proceso largo desde la migración al VPS del 08/08/2026. En la era Vercel, con
invocaciones aisladas, un `Map` en memoria no contaba nada. Si alguna vez se
vuelve al deploy de Vercel (que sigue siendo el rollback), **este presupuesto
deja de contar y hay que saberlo**: degrada a no hacer nada, no a romper.

**La regla, una sola y sin excepciones:** toda respuesta que el webhook origina
por su cuenta consume presupuesto, con clave `(botId, chatId)`. No hay caso
especial para vinculados, y no hace falta: al usuario vinculado el webhook casi
nunca le contesta, sus mensajes van por entrega y sus respuestas por
`/v1/messages`, que es otro camino y no está presupuestado.

**Parámetros:** 5 respuestas por ventana de 1 hora, tope de 5.000 claves en el
mapa. El 5 sale del flujo real de vinculación, que necesita entre 2 y 4 mensajes
(escribir al bot, leer la pista, mandar el código, quizás un typo). Un chat que
inunda pasa de miles de respuestas por hora a 5.

**La ventana es fija, no deslizante**: arranca con la primera respuesta a esa
clave y a la hora se descarta entera. Una ventana deslizante obligaría a guardar
un timestamp por respuesta en vez de un contador, y no compra nada acá: el
objetivo es amortiguar, no medir con precisión.

**Los tres parámetros entran por construcción, no como constantes del módulo**,
para que los tests puedan usar un tope de 3 claves en vez de simular 5.001.

🚨 **El mapa tiene que estar acotado con expulsión, y ésa es la parte que puede
salir peor que el problema.** Un `Map<chatId, contador>` sin tope es exactamente
el memory leak que un atacante busca: cambia el chat id en cada mensaje y llena
la RAM en vez de la base. Al desbordar se barren primero las entradas vencidas,
y si sigue lleno se expulsa la de ventana más vieja.

**Se inyecta, no se importa donde se usa.** Es estado, y `src/create-app.ts` no
puede tener estado propio sin romper el invariante de dependencias inyectadas.
Se construye en `wire.ts` y entra en `Deps`, que es además el lugar correcto
para que el hecho «esto cuenta por proceso» sea visible.

```ts
export interface PresupuestoDeRespuestas {
  /** Consume una unidad y devuelve si había. */
  consumir(clave: string, ahora: Date): boolean
}
```

El reloj entra por parámetro porque `deps.now` ya está inyectado en todo el
servicio: los tests adelantan el tiempo sin dormir.

### 4. El crudo de las filas `skipped` no se guarda

Por el razonamiento de arriba. Se conserva la fila, el `text` y todo el resto de
las columnas; sólo `raw` va en `'null'::jsonb`. Las filas de contactos
vinculados no cambian en nada.

⚠️ El repositorio inserta con `${sql.json(input.raw as Json)}`. Que
`sql.json(null)` produzca un JSON `null` y no un SQL `NULL` (que violaría el
`NOT NULL`) hay que **verificarlo con un test de integración**, no asumirlo:
es exactamente el tipo de detalle que pasa en verde en la suite sin base y
revienta en producción.

## Qué queda deliberadamente afuera

### Retención de `inbound_messages`

Hoy no hay borrado y hace falta, pero es **higiene de datos, no el arreglo de
seguridad**, y la aritmética de arriba lo confirma: 1 GB son ~2 millones de
mensajes. Va en su propio spec y su propio PR porque es lo único de todo esto
que tiene migración (índice sobre `received_at`) y **un paso de ops fuera del
repo** (un systemd timer nuevo en el VPS). Mezclarlo escondería el riesgo de los
otros cuatro cambios.

Cuando se haga, dos decisiones que ya se pueden anotar: va en un
`/internal/purge` propio y **no** adentro de `/internal/tick`, porque el tick
corre cada 15 minutos y su trabajo son los reintentos, y un `DELETE` masivo
adentro haría que una purga lenta retrase entregas. Y las políticas son dos
distintas: las `skipped` de desconocidos son descartables, las `delivered` son
el log de auditoría y esa retención la decide Juan.

### Límite por IP

Descartado in-app. En la puerta 2 el que llama es Telegram, así que un límite por
IP le pegaría a Telegram entero. En la puerta 1 sirve, pero ahí gana el borde.

### La regla WAF de Cloudflare

Una regla que restrinja `/webhooks/telegram/*` a los rangos publicados de
Telegram cierra la **puerta 1 entera**, con cero consultas a la base y cero
código. Es estrictamente mejor que cualquier cosa in-app para esa puerta,
incluido un cache de slug a secreto.

Queda afuera de este spec por dos razones. Su costo real es que **no vive en el
repo y Vitest no la cubre**, lo que choca con la regla de que todo cambio va con
test que pueda fallar. Y ⚠️ **los rangos no están verificados**: hay que
confirmarlos contra el log de acceso de Caddy en el VPS antes de poner nada, o
se cortan los entrantes reales. Es tarea de ops, con su verificación propia.

No toca la puerta 2: Telegram sigue siendo un origen legítimo.

### Mover la consulta a `bots` después de validar el secreto

Imposible por diseño, ya explicado arriba.

## Verificación

Tests nuevos, todos capaces de fallar contra el código de hoy:

| # | Qué prueba | Cómo falla hoy |
|---|---|---|
| 1 | El 200 al no vinculado vuelve antes de que el envío termine | El doble de `sendMessage` no resuelve hasta que el test lo suelta; hoy el request queda colgado |
| 2 | Si `sendMessage` tira, el webhook igual devuelve 200 | Hoy devuelve 500 |
| 3 | La promesa que se le pasa a `waitUntil` **resuelve** aunque `sendMessage` tire | Sin el `.catch` explícito rechaza, que es la unhandled rejection |
| 4 | El cliente de Telegram aborta al vencer el timeout | Hoy no hay `AbortSignal` y espera para siempre |
| 5 | El sexto mensaje de un chat desconocido en la ventana no genera envío | Hoy genera los seis |
| 6 | Un `/vincular` de un chat desconocido también consume presupuesto | Confirma que la regla es única y no tiene excepciones |
| 7 | Pasada la ventana, vuelve a contestar | Se adelanta `now`, sin dormir |
| 8 | Con el tope en 3, la cuarta clave distinta deja el mapa en 3 | Hoy no hay mapa |
| 9 | Un contacto vinculado se entrega igual con el presupuesto agotado | Confirma que la regla única no lo silencia |
| 10 | Una fila `skipped` queda con `raw` nulo y una vinculada conserva el crudo | Hoy las dos guardan el crudo |
| 11 | **Integración:** el insert con `raw` nulo no viola el `NOT NULL` | Es el único que necesita base; se saltea sin `DATABASE_URL` |

El 3 se afirma sobre la promesa, no con un handler de `unhandledRejection`
global: el handler es sensible al orden en que Vitest corre los archivos y
dejaría un test que a veces mide otra cosa.

Línea base a mantener, medida en este worktree con `DATABASE_URL='' bun run test`:
**252 pasan, 20 se saltean, 4 archivos salteados.**

Verificación contra producción, después del deploy: mandarle un mensaje al bot
desde un chat **no vinculado** y confirmar en la base que la fila quedó con
`raw` nulo y `delivery_status = 'skipped'`, y que el sexto mensaje seguido no
genera respuesta. El mensaje del contacto real tiene que seguir funcionando,
que es el circuito del gimnasio y está en el camino crítico.

## Riesgos

- **El presupuesto se pierde al redeploy.** Aceptado: para amortiguar abuso
  alcanza, y la alternativa (persistirlo) agrega una escritura por mensaje, que
  es justo lo que se quiere evitar.
- **El presupuesto no cuenta en Vercel.** Documentado arriba. Degrada a no hacer
  nada.
- **Un usuario real que se pase de 5 mensajes en una hora sin vincularse queda
  en silencio hasta la próxima ventana.** Es el precio, y el flujo real necesita
  entre 2 y 4.
- **El timeout de Telegram alcanza también al saliente.** Es una mejora, pero es
  un cambio de comportamiento en un camino que hoy anda: un api.telegram.org
  lento pasa de colgar el request a marcar `send_failed`.
