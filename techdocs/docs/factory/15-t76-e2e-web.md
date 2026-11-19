# 15 · T76 · E2E de la plataforma web

`bun run e2e` prueba la web de fab de extremo a extremo, como la usaría el dueño, y sale con código 1 si se rompe cualquier flujo. Cada acción se comprueba en el **Store** (abierto en solo lectura desde el script): estado, evento y actor, no solo el HTML.

## Cómo ejecutarlo

```bash
bun run e2e
```

Requisitos: `bun`, `git` y `agent-browser` en el `PATH` (sesión `fab-e2e`, con `--no-sandbox`). No usa red externa, agentes reales ni `~/.fabrica`: todo ocurre en un directorio temporal que se borra al terminar.

Deja las capturas y `resumen.json` en `docs/research/warp-platform/capturas-e2e/`. El resumen cuenta flujos `ok`, `conocido` (fallo de producto ya diagnosticado, no rompe la salida) y `fallo`.

## Cómo funciona

| Pieza | Fichero | Qué hace |
|---|---|---|
| Siembra | `scripts/e2e/sembrar.ts` | Crea un `stateDir` con tres workstreams sobre repos git desechables más uno para el pool `fake`, perfiles v1 y v2 con roles, señales, changes en varios estados, dos revisiones pendientes, una pregunta abierta con el esquema de admisión, una automation, evidencia en `runs/` y un experimento. |
| Recorrido | `scripts/e2e/run.ts` | Arranca `fab web --port 0 --write`, lee el enlace de un solo uso, lo canjea en el navegador y recorre los flujos. |

Reglas del script:

- **Sin esperas por tiempo fijo.** Tras un envío espera al aviso de la página (`p.notice[role=status]`) o a la URL de destino, con un tope de 20 s. Abre siempre la página de nuevo antes de actuar: el aviso es de un solo uso y el sondeo de la web lo repinta a los 2 s.
- **Efecto en el Store.** Cada acción mide el id máximo de `events` antes y exige que los eventos nuevos existan y lleven el actor `web` (o `api:<clave>` en la API).
- **«No crea ningún turno».** Crear y triar una señal, o ejecutar una automation, deja igual el número de filas de `adm_turns` y de activities `in_progress`.

## Qué cubre

| Flujo | Comprobación en el Store |
|---|---|
| Canje del enlace | El mismo enlace dos veces da 401. |
| Bandeja y filtros de changes | Búsqueda, estado, workstream y texto filtran la lista. |
| Crear y triar una señal | Señal `new` → `triaged` con change `pending`; sin turnos ni activities en curso. |
| Ignorar una señal | Estado `ignored`. |
| Aprobar / pedir cambios | `review_status` `approved` / `commented` con el comentario; pedir cambios sin comentario se rechaza. |
| Responder la pregunta | `adm_questions` `answered`, `answered_by = web`, la activity vuelve a la cola. |
| Nota | La nota queda sin entregar; no hay turnos. |
| Reintentar | El change vuelve a `pending` con una activity reencolada. |
| Cancelar con confirmación | Sin marcar la confirmación no se envía; con ella, `canceled`. |
| Renombrar | Título nuevo. |
| Automation | Ejecutar crea una señal (no un turno); pausar y activar cambian `enabled`. |
| Perfiles | Guardar crea un digest nuevo sin asignarlo; asignar lo fija en el workstream. |
| Workstreams | Ajustes, archivar (un slug distinto se rechaza) y asistente de alta en cinco pasos (queda en `draft`). |
| Métricas, configuración, flujo, experimentos y sección de turnos | La página carga y muestra lo esperado; un change inexistente da «Registro no encontrado». |
| Pool `fake` | `runPool` hace avanzar el change triado a `in_review` y la web lo refleja. |
| API | Sin clave 401; clave de lectura puede leer y no escribir (403); clave `decide` escribe con actor `api:<nombre>`; `merge` y `gate` no existen (404 y ausentes de `ACTIONS`). |
| Seguridad | POST sin sesión 401; `Origin` ajeno o ausente y CSRF inválido 403; `Host` ajeno 403; sin `--write`, todo POST 405. |

## Qué no cubre

- Turnos vivos con log y reportes (`adm_turns`): el pool corre sin `--live`, así que la sección «Turnos» solo se comprueba en su estado vacío.
- El aviso de notificaciones del navegador y el «Marcar como visto» (viven en `localStorage`).
- Agentes reales, `fab merge` y publicación: la web no los expone (D-F).
- La clave de API se crea con `Store.createApiKey`: la CLI no tiene un comando `fab api-key` en esta rama.
