# Reporte — ola2b opencode: sonda 08 en run.json

Rama `fab/research-ola2b-opencode`, un commit sobre `main@e7a38c8`, sin merge ni push.

## Cambios
- `src/agent/registry.ts`: tras la sonda, si existe `FABRICA_EGRESS_PROBE_FILE`, escribe ahí el resultado. El motor `native` corre como subproceso (`exec.ts`), así que el global `getLastEgressProbe` del hijo no llega al pool.
- `src/pool.ts`: pasa esa ruta (`<run>/<activity>.egress.json`) por `env` del adaptador. Tras el run, guarda `egressProbe` en el json de la activity (`readEgressProbe` si el agente es `native`, `null` si no).
- `src/manifest.ts`: `readEgressProbe(path)` devuelve `{reachable, decided, positiveControl, probedAt}`, o `null` si no hay archivo o está corrupto. El fallback sin metadatos también lleva `egressProbe: null`. `run.json` lo recoge porque ya hace spread del json de la activity.
- `tests/manifest.test.ts`: un test cubre tres casos. `native` con sonda simulada deja el resultado. `native` sin sonda deja `null`. `fake` deja `null` aunque escriba el archivo.

## Pruebas
- `bun test`: 842 pass, 0 fail (base 841 + 1).
- `bunx tsc --noEmit`: sin errores.

## Límites
- `details` y `durationMs` de la sonda no se llevan al manifest (el contrato pide solo cuatro campos).
- Si una activity se reintenta, el archivo de la sonda anterior puede seguir en disco y reutilizarse. El pool no lo borra antes de lanzar el agente.
