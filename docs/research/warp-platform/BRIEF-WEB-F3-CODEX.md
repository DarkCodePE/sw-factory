# Brief: `fab web` F3, panel de métricas (Codex)

Eres un implementador sin contexto previo.

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-webf3`, rama `feat/fab-web-f3`, creada desde `feat/fab-web` (PR #80, aún sin fusionar). `node_modules` es un symlink: no lo toques.
- **Antes de empezar, lee:**
  - `AGENTS.md`;
  - en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/`: `catalogo-fable.md` (C18-C20 y §6), `impl-codex.md` y `verif-fable.md`.
- **Trabajo en paralelo:** otro agente hace F2 (acciones) en `sw-factory-webf2`. Para no chocar:
  - pon todo lo tuyo en módulos nuevos (`src/web-metrics.ts`, `src/metrics.ts`, etc.);
  - en `src/web.ts` toca solo el despacho de rutas y el enlace de navegación.

## Objetivo
Crear una página `/metricas`, equivalente al Dashboard de Warp (Productivity y Spending), con los datos que fab ya guarda. **Solo lectura**: sigue en vigor todo lo de F0/F1 (Store `readonly`, solo GET y HEAD, CSP, `Host`).

Métricas, con filtro por workstream y rango de fechas (7 días, 30 días o todo):
1. **Tiempo de ciclo por tramo**, con mediana y p90:
   - creación del change → primera activity;
   - → primera revisión pedida;
   - → decisión humana;
   - → estado terminal.

   Elige los tramos según los eventos y columnas que existan de verdad. Documenta de qué evento o columna sale cada uno.
2. **Intervenciones humanas por change:** decisiones de revisión, respuestas y reintentos.
3. **Changes por estado y activities por tipo** en el rango.
4. **Coste:**
   - total;
   - por change, con top 10;
   - por adaptador o agente;
   - por modelo, si la evidencia lo trae.

   Reutiliza `activityCosts` y `changeCost` de `src/evidence.ts`. **Lo desconocido se muestra «No medido» y nunca suma como cero.** Indica cuántos changes no tienen coste medido.

## Decisiones ya tomadas
1. **Sin migraciones ni columnas nuevas.**
   - Si una métrica no se puede calcular con lo que hay, muestra «No medido» y explícalo en el informe.
   - Leer la evidencia de disco por petición puede ser caro. Pon un tope de changes por cálculo, con aviso, y una caché en memoria por mtime si hace falta. Mide el tiempo con 1000 changes sintéticos.
2. **Gráficos:**
   - SVG generado en el servidor, sin librerías ni JS;
   - barras horizontales o tablas con barras;
   - siempre con la tabla de valores accesible al lado (no solo color);
   - en tema claro y oscuro.
3. **Consultas al Store.** Si hacen falta, añádelas como métodos de **solo lectura** del Store y cuéntalas en el informe. No metas SQL suelto en la capa web.
4. **El sondeo de 2 s no aplica** a esta página. Pon un botón «Actualizar» o un sondeo de 30 s.

## Pruebas
- Tests en `tests/web-metrics*.test.ts`:
  - cada métrica con datos sintéticos de resultado conocido (medianas exactas);
  - lo desconocido no suma como cero;
  - filtro por workstream y por fecha;
  - escapado;
  - 405 en métodos de escritura;
  - que no se crea nada en disco.
- **Mutaciones propias** en una copia temporal: cambia el cálculo de la mediana, la suma con `null`, el filtro de fecha y el filtro de workstream, y comprueba que cada cambio rompe algún test.
- `tsc --noEmit -p .` y `bun test tests`.
  - La máquina va justa de RAM: ejecuta la suite completa **una sola vez**, al final.
  - Si falla un test de red o de carga, repítelo aislado y anótalo.
- **Recorrido manual con agent-browser:**
  - sesión `fabf3`, con `--args "--no-sandbox"` si hace falta;
  - sobre un `stateDir` temporal con datos sintéticos;
  - **nunca** `~/.fabrica` ni `~/.fabrica-t11`;
  - capturas en 1440 y 390 px, en ambos temas, en `docs/research/warp-platform/web-capturas-f3/`.

## Reglas
- Commits pequeños en español, **sin `Co-Authored-By`**, sin push, sin escribir en GitHub, sin subagentes, sin secretos.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/impl-f3-codex.md` con estas secciones:
- veredicto;
- métricas, cada una con su fuente de datos;
- commits;
- cambios por fichero;
- rendimiento medido;
- mutaciones;
- tests;
- prueba manual;
- lo que no hiciste;
- riesgos.

Última línea, exactamente: `<!-- FIN -->`.
