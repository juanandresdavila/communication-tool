# Acta de deploy: endurecimiento por la auditoría de octubre

**Fecha:** 23 de octubre de 2026, 22:57 (hora argentina)
**Qué se deployó:** `main` en `cba6a60`, el merge del PR #25.
**Dónde:** el VPS, con el procedimiento de siempre (`git pull` en el checkout fuente, `docker compose build app`, `docker compose up -d app`).

## Antes del deploy

Se verificaron las cuatro precondiciones del PR:

| Precondición | Cómo se verificó |
|---|---|
| Ningún secreto de producción por debajo de 32 caracteres | Se midió largo y clase de caracteres de cada uno sin imprimirlos; los que no cumplían se rotaron y se volvieron a medir. |
| Ninguna URL de entrega ni de callback contesta 3xx | POST con `redirect: 'manual'` desde adentro del contenedor a cada URL de las apps activas: ninguna redirige. |
| El proyecto viejo de Vercel y su base ya no existen | Dados de baja; la URL vieja contesta `DEPLOYMENT_NOT_FOUND`. |
| `/internal/*` se filtra en el borde | Desde Internet, `POST /internal/tick` da 404 de Caddy, sin llegar a la app. |

Se rotó `INTERNAL_SECRET`. Se rotó también el secreto del webhook del bot de gym, y el webhook se volvió a registrar con la misma URL.

Antes de construir, la imagen anterior se guardó con la etiqueta `comm-tool-app:pre-endurecimiento`.

## Después del deploy

| Chequeo | Resultado |
|---|---|
| Arranque | Una sola línea, `comm-tool escuchando en :3000`. `revisarSecretos` no avisó nada: no falta ni falla ninguna variable. |
| Contenedor | `running`, sin reinicios. Bun 1.4.4. |
| `/health?deep=1` | `ok`, base `ok`. |
| Tick del timer | `success`, con la respuesta del tick nuevo. |
| Desde Internet | `/health` 200; `/internal/tick` 404; webhook y `/v1` sin credencial, 401. |
| Errores en el log | Ninguno en los primeros minutos. |

## Volver atrás

La imagen anterior quedó etiquetada. Para volver:

```bash
cd /opt/stacks/comm-tool
docker tag comm-tool-app:pre-endurecimiento comm-tool-app
docker compose up -d app
```

Los secretos rotados siguen sirviendo con la imagen anterior, porque cumplen la regla vieja y la nueva.

## Pendiente

- Borrar el job viejo de cron-job.org, que le pegaba al deploy de Vercel. Ya no sirve: el deploy no existe y la clave que tiene fue rotada.
- Borrar el otro proyecto de Vercel que sigue conectado al repo, sin variables. Deploya cada PR y cada merge a `main`.
- PR aparte con tres menores de la revisión: el marcador sin corchetes, dos tests que faltan y loguear el motivo en `fire.ts`.
- Borrar la etiqueta `pre-endurecimiento` cuando haya pasado una semana sin problemas.
