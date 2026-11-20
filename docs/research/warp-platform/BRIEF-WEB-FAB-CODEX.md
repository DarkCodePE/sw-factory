# Brief: `fab web`, fases F0 y F1 (Codex)

Eres un implementador sin contexto previo.
- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-fabweb`, rama `feat/fab-web`, creada desde `origin/release/0.1.0-rc.12`. `node_modules` es un symlink, no lo toques.
- **Lee antes de empezar:**
  - `AGENTS.md` del worktree.
  - `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/catalogo-fable.md`. Contiene el catálogo de Warp Factories, el cruce con fab, lo que **no** hay que copiar (§5) y el plan por fases (§6). Las rutas `src/...` que cita son de un worktree con el mismo código que el tuyo.
- **No abras `capturas/`:** contienen datos personales. El catálogo basta.

## Objetivo
Hacer la primera web de fab: el comando `fab web`, con las fases **F0 (lectura)** y **F1 (evidencia)** del catálogo. Las capacidades se inspiran en Warp: bandeja, lista filtrable, detalle con jerarquía, timeline, coste y metadata. El diseño y el vocabulario son **propios de fab**: workstream, change, activity, señal, validador y gate. No uses los nombres, la disposición de tres paneles ni la estética de Warp.

## Decisiones ya tomadas (no las reabras)
1. **Solo local:** escucha en `127.0.0.1`, monousuario. El puerto por defecto es configurable con `--port`.
2. **Solo lectura.** Ninguna ruta muta el Store ni el disco. No hay POST, ni `merge`, ni `gate allow`, ni aprobaciones. Eso será F2 y no entra aquí.
3. **Stack:** `Bun.serve` y HTML generado en el servidor, con una sola hoja de estilo y un poco de JS para sondear cada 2 s, como la TUI. **Sin dependencias nuevas** y sin peticiones externas: nada de CDN ni fuentes remotas.
4. **Mismo binario:** el subcomando `fab web` va en `src/cli.ts`. La web es otra superficie, como la CLI y la TUI, y **no contiene reglas**. Llama a las consultas que ya existen (`listWorkstreams`, `listChanges`, `listActivities`, `inbox`, `listEvents`…). No dupliques lógica del dominio.

## Alcance
**F0 · Lectura**
- **Inicio:** bandeja (`Store.inbox`) con contadores por estado.
- **Workstreams:** lista y selector.
- **Changes:** lista con filtro por estado y búsqueda por título, en el servidor y por query string.
- **Detalle de change:** sus activities como árbol (`parent_activity_id`), sus eventos en orden y su estado.

**F1 · Evidencia**
- **Detalle de activity:** log, `run.json`, diff si existe, veredictos de validadores, coste y duración por intento.
- **Coste:** sumado por change.
- **Lector de evidencia compartido:** extrae la lectura que hoy está repartida entre `src/manifest.ts`, `src/improve.ts` y la TUI a un módulo común, y haz que la TUI lo use si eso no cambia su comportamiento.
- **Redacción:** aplica la de `src/manifest.ts` también al servir, porque los logs antiguos pueden no estar redactados.
- **Tamaño:** pon un tope y trunca los ficheros grandes con un aviso.

## Requisitos de seguridad (no negociables)
- **Base de datos en solo lectura de verdad:** abre SQLite con `readonly: true`. No crees esquema, no migres ni tomes locks de escritura. Lee la lección de T13-b: `--mode off` creaba el esquema. Un test debe probar que `fab web` sobre un `stateDir` inexistente o vacío **no crea nada**.
- **Escapado:** todo texto que venga de issues, logs o agentes se escapa como HTML. Es dato, no marcado. Pon un test con `<script>` en un título y en un log.
- **Cabecera `Host`:** rechaza con 403 las peticiones cuya `Host` no sea `127.0.0.1:<port>` ni `localhost:<port>`. Así se evita el DNS rebinding.
- **Rutas de evidencia:** solo dentro del `stateDir`, sin `..` ni symlinks que salgan de él. Pon un test de path traversal.
- **Cabeceras:** `Content-Security-Policy` que prohíba orígenes externos, más `X-Content-Type-Options: nosniff`.

## Diseño
- Interfaz sobria y legible, en **español**, con tema claro y oscuro (`prefers-color-scheme`), usable a 390 px y en contraste WCAG AA.
- Estados con color y texto, nunca solo color.
- Estructura con navegación lateral (workstreams) y contenido principal. Para el detalle de change, una lista o árbol de activities y la evidencia debajo o al lado. Decide tú, pero que no sea una copia de Warp.

## Pruebas y verificación
- **Tests nuevos** en `tests/web*.test.ts`. Cubre:
  - cada ruta, con un Store de prueba que tenga datos;
  - escapado, cabecera `Host`, path traversal y que no se cree nada en solo lectura;
  - que ninguna ruta acepte métodos distintos de GET y HEAD (405).
- Pasa `bun test tests` y `tsc --noEmit -p .` en verde. Si falla un test que no tiene nada que ver (por ejemplo `pool-live` por carga, de la familia T45), repítelo y anótalo, pero no lo arregles.
- **Prueba manual con agent-browser:**
  1. Arranca `fab web` sobre un `stateDir` temporal sembrado con datos de prueba. **No uses `~/.fabrica`, ni `~/.fabrica-t11`: este último tiene una medición en curso.**
  2. Recorre las páginas en 1440 y 390 px y en ambos temas.
  3. Guarda las capturas en `docs/research/warp-platform/web-capturas/` del worktree.
  4. Recoge los errores de consola.
  - Si agent-browser falla con «No usable sandbox», añade `--args "--no-sandbox"`. Usa una sesión propia (`--session fabweb`), no la `warp`.

## Reglas
- Haz commits pequeños en español, **sin `Co-Authored-By`** (CLAUDE.md #2078).
- **No hagas push** ni escribas en GitHub (PR, issues, comentarios).
- No toques nada fuera del worktree, salvo tu informe.
- No lances subagentes. No guardes secretos ni `.env`.
- Si algo del alcance choca con una regla de `AGENTS.md`, para, apúntalo en el informe y sigue con el resto.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/impl-codex.md` con estas partes:
- **Veredicto:** una frase.
- **Rutas:** cada ruta HTTP con qué consulta del Store usa.
- **Commits:** hash y mensaje de cada uno.
- **Cambios por fichero.**
- **Tests:** comando y resumen de la salida.
- **Prueba manual:** las rutas de las capturas y los errores de consola.
- **Seguridad:** cómo cumpliste cada requisito y con qué test.
- **Decisiones de diseño** que tomaste.
- **Lo que no hiciste**, y por qué.
- **Riesgos** para la verificación.

Última línea, exactamente: `<!-- FIN -->`.
