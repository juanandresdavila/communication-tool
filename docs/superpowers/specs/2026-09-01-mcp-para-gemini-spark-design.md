# Servidor MCP para Gemini Spark

**Fecha:** 2026-09-01
**Estado:** diseño aprobado, pendiente de plan de implementación
**Alcance:** communication-tool. No toca ningún consumidor.

## Problema

Gemini Spark es el agente permanente de Google: corre en la nube, lee Gmail,
Calendar, Drive, Docs, Tasks y Keep, y ejecuta tareas programadas por su
cuenta. Lo que no sabe hacer es escribirle a Juan por Telegram.

comm-tool sí: es exactamente su trabajo. Falta la puerta por la que Spark
pueda pedírselo.

El caso concreto que motiva esto: **un digest diario de los pendientes de la
uni, que Spark arma leyendo su Google Calendar y manda por Telegram**. Spark
pone el contenido y el horario; comm-tool pone el transporte.

## Por qué MCP y no otra cosa

Spark no expone API pública ni webhooks para terceros. Su única puerta
documentada para servicios propios es cargar la **URL de un servidor MCP** en
*Connected apps*. Es eso o nada.

## Qué se construye

Un servidor MCP mínimo montado en el mismo servicio, en `POST /mcp`, que
expone dos herramientas de salida apoyadas sobre lógica que ya existe y ya
está probada en producción.

### Restricción conocida, y aceptada

Los custom MCP de Spark hoy exigen **cuenta personal de Google, mayor de 18,
residencia en Estados Unidos, y están solo en inglés**. Desde Argentina no se
puede conectar todavía. Se construye igual, a sabiendas: el endpoint sirve a
cualquier cliente MCP, y la verificación de este trabajo no depende de Spark
(ver «Verificación»).

## Decisiones

### JSON-RPC a mano, sin dependencia nueva

Se descarta `@modelcontextprotocol/sdk`. Trae su propio objeto servidor y su
propio transporte, asume Node, y este repo tiene cinco dependencias y el
invariante de que todas las dependencias entran inyectadas por `createApp`.

La revisión **2026-07-28** del protocolo hace que el costo de escribirlo a mano
sea chico: eliminó las sesiones y el stream GET. Un servidor mínimo es un solo
POST que contesta `application/json`. Sin SSE, sin `Mcp-Session-Id`, sin estado.

### Se soportan las dos eras del protocolo

No se sabe qué revisión habla Spark, y no se puede averiguar mientras el
producto no esté disponible acá. Se implementan las dos:

| Era | Handshake | Métodos |
|---|---|---|
| **2026-07-28** (actual) | metadata por request en `params._meta` | `server/discover`, `tools/list`, `tools/call` |
| **2025-06-18 / 2025-11-25** (legacy) | `initialize` + `notifications/initialized` | `initialize`, `tools/list`, `tools/call` |

La era se decide por request: si viene el header `MCP-Protocol-Version` con un
valor moderno, se aplica la validación de headers y el `_meta` obligatorio; si
no viene, o viene una versión vieja, se acepta el camino `initialize`.

Esto además es lo que permite verificar con un cliente real hoy: cualquiera de
las dos eras que hable el cliente que tengamos a mano queda cubierta.

### Las tools solo mandan

`programar` y `cancelar_programado` quedan **deliberadamente afuera**. El
scheduler de comm-tool dispara posteando a un `schedule_callback_url` HTTP, y
Spark no expone ninguno: un programado creado por Spark se marcaría `failed`
sin postear a nadie y sin que nadie mire la columna. Exponer una tool que falla
en silencio es peor que no exponerla.

Quien programa es Spark, con sus propias tareas recurrentes.

## La superficie MCP

### `enviar_mensaje`

| Argumento | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `userId` | string | sí | Destinatario. Hoy el único vinculado es `juan`, y va dicho en la descripción de la tool. |
| `text` | string, 1 a 4096 | sí | Texto libre. El `maxLength` va declarado en el `inputSchema` para que el modelo parta un digest largo en vez de comerse un 400. |
| `idempotencyKey` | string, opcional | no | Si Spark reintenta el envío del día con la misma clave, no llegan dos mensajes. |

`kind` no se expone: queda fijo en `notification`, que es lo único que Spark
manda. Despacha a `enviarSaliente` (`src/outbound/send.ts`), sin lógica de
envío nueva.

### `ver_contacto`

Un argumento, `userId`. Devuelve si está vinculado. Existe para que el modelo
pueda chequear antes de mandar y dar un error entendible en vez de un 404 crudo.

### Errores

Se respeta la distinción del spec, porque determina si el modelo se recupera o
abandona:

- **Errores de protocolo** (JSON-RPC `error`): tool desconocida, cuerpo
  malformado, versión no soportada, headers que no coinciden.
- **Errores de ejecución** (`isError: true` con texto): `not_linked`,
  `send_failed`, `in_progress`. Son los que el modelo puede corregir solo.

### Nombres en español

Igual que el resto del repo (`enviarSaliente`, `cuerpoSchema`, `rutas`). Spark
solo funciona en inglés, pero Gemini no tiene problema con descripciones en
español.

## Arquitectura

| Archivo | Responsabilidad | Depende de |
|---|---|---|
| `src/mcp/protocol.ts` | Sobre JSON-RPC, negociación de versión, validación de headers, códigos de error. Puro, sin I/O. | nada |
| `src/mcp/tools.ts` | Las dos definiciones (nombre, descripción, `inputSchema`) y el despacho. | `enviarSaliente`, `ContactsRepo` |
| `src/routes/mcp.ts` | La ruta Hono. `POST /mcp`; `GET` y `DELETE` devuelven 405. | los dos de arriba |

Se monta en `create-app.ts` en su propio bloque con `apiKeyAuth(deps.apps)`. El
patrón del middleware es `/mcp`, **no** `*`: con `*` corre sobre cualquier ruta
no matcheada y una URL inexistente devolvería 401 en vez de 404. Es la misma
trampa que ya está comentada en ese archivo para `/v1/*`.

No hay migración. No hay tabla nueva. No hay columna nueva.

## Identidad

App `spark` con su propia API key, y un **bot nuevo de BotFather al que nunca
se le llama `setWebhook`**.

Que el bot no tenga webhook es lo que hace seguro agregar esto: el webhook de
Telegram es exclusivo por bot, y el último `setWebhook` le saca los updates al
anterior sin error ni aviso. Sin registro, este bot no puede robarle nada a los
tres que ya andan.

Dos consecuencias de que `apps.delivery_url` sea `NOT NULL`:

- El alta va con `--delivery-url https://spark.invalid/no-recibe-entrantes`.
  `.invalid` es TLD reservado, garantizado a no resolver: si algún día algo
  intenta usarlo, falla ruidoso en vez de postear a un lado equivocado.
- Sin webhook no hay `/vincular`, así que el contacto se inserta a mano con el
  chat id de Juan, que es el patrón que el `CLAUDE.md` ya documenta para probar
  salientes.

`app_user_id` es `juan`, una etiqueta. Acá sí puede serlo: a diferencia de
GymTracker, ninguna app referencia este valor por clave foránea.

`delivery_secret_env` también es `NOT NULL`: se le da un nombre y un valor
aleatorio que nunca se lee, porque solo lo usa la entrega de entrantes.

## Seguridad

| Qué | Cómo |
|---|---|
| **Autenticación** | El `apiKeyAuth` que ya existe: `Authorization: Bearer <api key de spark>`. |
| **Origin** | Si el request trae header `Origin`, **403**. Sin lista blanca y sin configuración. |
| **Headers** | `MCP-Protocol-Version`, `Mcp-Method` y `Mcp-Name` se validan contra el cuerpo; si no coinciden, 400 con `-32020`. Obligatorio en la revisión nueva. |
| **Método desconocido** | 404 con `-32601`, que es lo que distingue a un servidor moderno de uno legacy. |
| **Versión no soportada** | 400 con `-32022` listando las soportadas. |

La regla de `Origin` merece su justificación: el spec obliga a validarlo contra
DNS rebinding, y acá ningún cliente MCP legítimo es un navegador. La API key es
un bearer que no debe ser alcanzable desde una página. Rechazar cualquier
request con `Origin` es la lectura más estricta y no necesita configuración.

**OAuth queda fuera de alcance.** El framework de autorización de MCP es OAuth,
y la UI de Spark ofrece cargar credenciales a mano bajo *Advanced features*
para servidores sin Dynamic Client Registration. Se apuesta a ese camino. Si
Spark termina exigiendo DCR, esto no conecta y hace falta construir un
authorization server, que es más trabajo que el servidor MCP entero. Sería un
proyecto aparte.

Consecuencia conocida y aceptada: el 401 sale sin header `WWW-Authenticate`,
así que un cliente que intente descubrir OAuth no va a encontrar a dónde ir. Un
cliente con token estático anda igual.

## Verificación

**El criterio de éxito es un mensaje llegando al Telegram de Juan, disparado
por un cliente MCP real que no seamos nosotros.** No alcanza con un curl que
escribimos y que interpretamos.

Como Spark no se puede conectar desde acá, el cliente de la prueba es **Claude
Code**, configurado contra `https://comm.jadd.com.ar/mcp` con la API key de la
app `spark`. Recorre el camino entero: negociación, `tools/list`, `tools/call`,
`enviarSaliente`, token del bot, Telegram.

Aparte, tests unitarios sin red y sin base, sobre los fakes de
`src/test-support/`:

- Sin API key, 401.
- `GET /mcp` y `DELETE /mcp`, 405.
- Con header `Origin`, 403.
- Header que no coincide con el cuerpo, 400 con `-32020`.
- Versión desconocida, 400 con `-32022`.
- Método desconocido, 404 con `-32601`.
- `tools/list` devuelve las dos tools en orden determinista, en las dos eras.
- `tools/call` feliz: manda y devuelve el `providerMessageId`.
- `tools/call` contra un usuario no vinculado: `isError: true`, no error de
  protocolo.
- La era legacy: `initialize` contesta, y `notifications/initialized` devuelve
  202 sin cuerpo.

## Lo que este trabajo NO hace

- **No abre el camino de vuelta.** Es una sola mano. Si Juan le responde al
  mensaje en Telegram, ese update se pierde: el bot no tiene webhook, y aunque
  lo tuviera, la entrega necesita un `delivery_url` HTTP del lado del
  consumidor y Spark no expone ninguno. Que Spark reciba respuestas no lo
  arregla ningún servidor MCP.
- No expone tools de programados.
- No implementa OAuth.
- No toca `/v1`, ni el webhook, ni el scheduler, ni ningún consumidor.
- No construye el servidor MCP de Study Master, que es el candidato siguiente
  si el digest diario resulta útil.

## Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Spark no está disponible en Argentina | No se puede conectar el destinatario final | Se sabe de antemano. El endpoint queda listo y verificado con otro cliente. |
| Spark exige OAuth con DCR | No conecta con token estático | Fuera de alcance, declarado. Sería un proyecto aparte. |
| Spark habla una revisión que no cubrimos | No conecta | Se soportan las dos eras vigentes. |
| Las tareas programadas de Spark no disparan confiable | El digest no llega algún día | Es de Spark, no nuestro. El síntoma es visible: no llega el mensaje. |
