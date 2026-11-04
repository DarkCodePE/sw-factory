# Tarea — opencode: resultado de la sonda 08 en el manifest de 04

Repo: /home/orlando/Desktop/factory/sw-factory-ola2b-opencode (rama `fab/research-ola2b-opencode`, base `main@e7a38c8`).

Hoy la sonda de egress del motor `native` (`src/sandbox/egress-probe.ts`, llamada en `src/agent/registry.ts`) emite el evento `egress_probe` con `{reachable, decided, positiveControl}`, pero el `run.json` que escribe `src/manifest.ts` no lo recoge. El plan (ficha 08) pide `{reachable, decided}` en el manifest.

## Qué hacer
1. Lee cómo `src/manifest.ts` construye `run.json` (campo `isolation` por adaptador) y cómo llegan los eventos del motor `native` al pool o al store.
2. Lleva el último resultado de la sonda de cada activity del motor `native` al `run.json`, junto a `isolation` de esa activity: `egressProbe: { reachable, decided, positiveControl, probedAt }`. Para los demás adaptadores, `egressProbe: null` (su postura ya está en `isolation`).
3. Si la sonda no se ejecutó (la activity no usó red), `egressProbe: null`.
4. Test: una activity `native` con un resultado de sonda simulado deja ese resultado en `run.json`; una de otro adaptador deja `null`.

## Propiedad
`src/manifest.ts` y lo mínimo en `src/sandbox/egress-probe.ts`, `src/agent/registry.ts` o `src/pool.ts` para transportar el dato, y `tests/manifest.test.ts`. agy toca en paralelo `src/threatmon/`: no lo toques.

## Entrega
`bun test` y `bunx tsc --noEmit` en verde (base 841). Un commit en español **sin `Co-Authored-By`**, sin merge ni push. Reporte en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola2b-opencode.md con los cambios y la salida de tests. Escríbelo aunque algo quede incompleto.
