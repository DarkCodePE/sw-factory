# Piloto T2 con Haiku (`t2-piloto-01`)

3 tareas de development de 3 repos (semilla 20261107) × 4 brazos × 1 repetición = 12 corridas, `claude-haiku-5-5`, `--confine`, concurrencia 4. Duración total: 241 s. Detalle en `comandos.md`; datos crudos en `report.json`. Con n=3 no se interpreta ningún efecto del candidato.

| Brazo | Éxito con ocultos | `integrity_ok` | Coste medio USD | Coste total USD | Duración media s | `confined` |
|---|---|---|---|---|---|---|
| baseline | 3/3 | 0/3 | 0,0238 | 0,0713 | 93,3 | 3/3 |
| baseline_rep | 3/3 | 0/3 | 0,0175 | 0,0524 | 63,5 | 3/3 |
| candidate | 3/3 | 3/3 | 0,0150 | 0,0449 | 55,7 | 3/3 |
| control | 3/3 | 0/3 | 0,0160 | 0,0479 | 60,2 | 3/3 |
| **Total** | 12/12 | 3/12 | 0,0180 | **0,2165** | 68,1 | 12/12 |

Coste muy por debajo del tope de 1 USD; no hubo que cortar.

## Observaciones
- **Tareas sin resolver por ningún brazo:** ninguna. Las 3 se resolvieron en los 4 brazos (12/12), así que no hay señal de descripción insuficiente. Con solo 3 tareas, y siendo mutaciones de un token, no dice nada sobre las otras 97.
- **Errores del lanzador:** ninguno. 12 corridas registradas, `confined: true` en todas, sin `is_error` en los logs.
- **pytest dentro del confinamiento:** sí se intentó en las 12 corridas y funcionó en algunas. Los logs (`state/runs/*/*.log`) solo guardan el resultado final del agente y sus `permission_denials`, no la traza de herramientas, así que el recuento es aproximado:
  - En 9 de las 12 corridas hay al menos un `pytest` denegado por permisos. Son comandos con `PYTHONPATH=…`, `cd /tmp/…` o copias a `/tmp`.
  - Hay informes con pytest ejecutado sin denegaciones (0 denegaciones registradas): tabulate/candidate (`289 passed, 36 skipped`), xmltodict/candidate y xmltodict/control (`79 passed`). (Nota: en xmltodict/baseline_rep el agente reportó `79 passed`, pero sí acumuló 4 denegaciones en su actividad de implementación).
  - Conclusión práctica: pytest del sistema es utilizable en parte de las corridas; a un agente le puede fallar si lo invoca con `PYTHONPATH` o fuera del worktree.
- `integrity_ok` está en 0/3 en baseline, baseline_rep y control, y en 3/3 en el candidato. Es lo que mide la métrica primaria; no se interpreta con n=3.
- Todos los diffs son pequeños (2–6 líneas).

## Causa de las denegaciones
Las denegaciones no provienen del confinamiento (`bwrap`), sino exclusivamente de la política de permisos de herramientas del agente Claude configurada en `src/agents.ts:50-59`:

```typescript
const claude: AgentAdapter = {
  name: 'claude',
  command: (prompt) => [
    'claude',
    '-p',
    prompt,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    [
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(git:*)', 'Bash(python3:*)', 'Bash(python:*)', 'Bash(pytest:*)',
      'Bash(npm ci:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npx vitest:*)', 'Bash(npx tsc:*)',
      'Bash(bun test:*)', 'Bash(ls:*)', 'Bash(cat:*)',
      'Bash(rtk:*)',
    ].join(','),
    '--output-format',
    'json',
  ],
  parse: parseClaudeJson,
};
```

- **Por qué `bwrap` no es la causa:** En `src/sandbox/confine.ts:23`, `bwrap` monta `/tmp` como tmpfs de lectura y escritura (`'--tmpfs', '/tmp'`). Cualquier fallo a nivel de kernel/sandbox generaría errores POSIX (`EACCES`/`EROFS`) en stderr y código de salida no cero, lo que abortaría el ejecutor según `src/agents.ts:246` (`if (options.confine && exitCode !== 0) throw new Error(...)`). Bwrap no tiene visibilidad de herramientas CLI ni genera estructuras `permission_denials`.
- **Por qué Claude CLI deniega:** En modo `-p` con `--permission-mode acceptEdits`, Claude deniega cualquier llamada a `Bash` que no comience estrictamente por uno de los prefijos permitidos en `--allowedTools`:
  - Prefijos de variables de entorno como `PYTHONPATH=src python3 ...` o `PYTHONPATH=. python3 ...` no coinciden con `Bash(python3:*)` porque el comando comienza por `PYTHONPATH=`.
  - Comandos como `cd /tmp/...`, `mkdir -p /tmp/...`, `cp ...`, `rm ...`, `echo ...` o `sed ...` no están en la allowlist.
- **Demostración:** En `sortedcontainers-count-ultimo-r1-baseline`, el agente invocó `python3 -m pytest -q -p no:cacheprovider -o pythonpath=src tests/`, pasando `src` mediante opción CLI de pytest en lugar de una variable de entorno previa. Al comenzar el comando por `python3`, fue admitido de inmediato por `--allowedTools` y pasó sin denegaciones dentro del confinamiento `bwrap` (245 passed).

## Proyección a 1 200 corridas (100 tareas × 3 repeticiones × 4 brazos)
- **Coste:** 0,018 USD × 1 200 ≈ **21,6 USD**. Es menos que los 30–40 USD estimados con T1, pero con 12 corridas de tareas pequeñas el margen de error es grande; presupuestar 25–35 USD cubre repos más grandes.
- **Duración con concurrencia 8:** 68,1 s medios × 1 200 / 8 ≈ 2,8 h. El rendimiento observado a concurrencia 4 (12 corridas en 241 s, con arranque incluido) extrapolado a 8 da ≈ 3,3 h. Rango **2,8–3,3 h**, siempre que la API no limite la tasa a 8 en paralelo (no se ha probado).
- No incluye `sortedcontainers` más pesado en disco, ni la preparación (~25 s).
