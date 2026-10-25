# Plan: LFM 2.5 en main y SDLC fase 2 (ronda 2026-10-24)

Coordinador: Claude (valida e integra). Ejecutor: **Codex**, en su worktree
`/home/orlando/Desktop/factory/sw-factory-codex`, una tarea detrás de otra.
Referencias: skill `fab-referencias` (`~/.agents/skills/fab-referencias/SKILL.md`).

## Estado de partida

- `main` = `5d77be6`. La ronda de conectores ya está integrada en
  `integ/sdlc-connectors` (`b2c7e15`, subida a origin; 598 pruebas pasan, 0 fallos).
  Pendiente de que el usuario la fusione en `main`.
- El soporte LFM2.5 solo existe en `feat/ollama-p1` (3 commits, 64 por detrás de
  `main`): `fe45dff`, `45b7825`, `11d96ed`. Al hacer cherry-pick chocan con `main`
  en `src/agent/provider.ts`, `src/agent/settings.ts`, `src/agent/exec.ts` y
  `src/agent/README.md`. `main` reescribió la petición HTTP con
  `withIdleResponse`, así que `fe45dff` está casi todo superado.
- Modelo: `LiquidAI/LFM2.5-2.6B` en la caché HF; vLLM 0.20.2 en
  `/tmp/claude-1000/-home-orlando-Desktop-ia-master-FineEnvs/b2b0e998-9b66-47c6-a8fb-a5e61594c59b/scratchpad/lfmvllm`.
  Necesita ~8 GB de GPU (12 GB en total; otras sesiones la usan para entrenar).

## Tareas

| # | Tarea | Quién | Rama / base | Estado |
| --- | --- | --- | --- | --- |
| 1 | Portar el parser LFM2.5 a `main` + smoke real con vLLM | Codex | `feat/lfm25-main` desde `main` | encargada |
| 2 | Probar `fab` actual con LFM2.5 en una tarea pequeña | Claude (valida) | tras 1 | pendiente |
| 3 | SDLC fase 2: triage, automatizaciones persistentes, AutoWiki, Monitor | Codex | `feat/sdlc-fase2` desde `integ/sdlc-connectors` | encargada (después de 1) |
| 4 | Prueba real Jira → PR con validadores | Claude | `integ/sdlc-connectors` | bloqueada: falta repo de pruebas en GitHub + HU de prueba |
| 5 | Gestión de contexto (lectura por rangos, compactación que conserva el plan, timeout total configurable) | sin asignar | — | bloqueo principal de la factory |
| 6 | CI/CD y deploy (paso 11 del diagrama), transición de estado en Jira | sin asignar | — | pendiente |
| 7 | Limpieza: worktrees `sw-factory-agy`, `-ollama`, `-tui`, `-agent`; README «Límites conocidos» | usuario decide | — | pendiente |
| 8 | Publicar `rc.10` (push de `release/0.1.0-rc.10` y tag) | usuario | — | pendiente |

---

## Tarea 1 — Codex: soporte LFM2.5 en `main`

Rama: `git switch -c feat/lfm25-main main` en `sw-factory-codex`. Commit local, sin push.

Qué portar (leer `git show 45b7825 11d96ed` en `feat/ollama-p1` y el informe
`/home/orlando/Desktop/factory/doc/droid-re/report-agy-lfm25.md` §2):

1. `toolCallParser?: 'lfm2' | 'pythonic'` opt-in en `OpenAICompatibleOptions`
   (`src/agent/provider.ts`), aplicado al turno que ya decodifican
   `decodeStream`/`withIdleResponse` de `main`. No reintroducir el `fetch` antiguo de
   `fe45dff`; de ese commit, solo lo que `main` aún no tenga (compruébalo y dilo en
   el informe).
2. Parser `<|tool_call_start|>[f(a=1, b="x")]<|tool_call_end|>` → `toolCalls`
   OpenAI: varias llamadas y sintaxis pythonic (strings multilínea, escapes,
   `True/False/None`). Si la llamada se corta a mitad de stream → `ProviderError`
   reintentable; nunca se ejecuta una herramienta de un turno corrupto.
3. Quitar `<think>…</think>` y el `</think>` huérfano del prefill de Jinja, tanto en
   texto normal como antes de `STATUS:` (fue la causa de `p1-lfm25-v1/run-04`).
4. `customModels.<id>.toolCallParser` en `src/agent/settings.ts`, propagado hasta el
   proveedor; `scripts/native-factory-smoke.ts` respeta `FABRICA_LLM_BASE_URL`.
5. Sección en `src/agent/README.md` (modelos locales, LFM2.5, `toolCallParser`).
6. Pruebas en `tests/agent.test.ts` (las de `45b7825` adaptadas) y una de regresión:
   sin `toolCallParser`, el flujo OpenAI estándar no cambia.

Validación del código: `bun test --max-concurrency=4` con 0 fallos, `bunx tsc --noEmit`,
`git diff --check`.

Smoke real (solo si `nvidia-smi` muestra ≥ 9 GB libres; si no, no lo arranques y dilo):

```bash
V=/tmp/claude-1000/-home-orlando-Desktop-ia-master-FineEnvs/b2b0e998-9b66-47c6-a8fb-a5e61594c59b/scratchpad
$V/lfmvllm/bin/python -m vllm.entrypoints.openai.api_server \
  --model $V/LFM2.5-2.6B-tf457 --served-model-name LiquidAI/LFM2.5-2.6B \
  --port 8088 --host 127.0.0.1 --gpu-memory-utilization 0.65 --max-model-len 16384 \
  --trust-remote-code
```

Si ese directorio ya no existe, usa el snapshot de
`~/.cache/huggingface/hub/models--LiquidAI--LFM2.5-2.6B` y dilo. Después lanza
`scripts/native-factory-smoke.ts` con `SMOKE_MODEL=LiquidAI/LFM2.5-2.6B`,
`FABRICA_LLM_BASE_URL=http://127.0.0.1:8088/v1` y unos settings con
`customModels` + `toolCallParser: "lfm2"`, en un fixture nuevo
(`/home/orlando/.cache/fab-smoke/lfm25-<n>`): 3 corridas. **Al acabar, para vLLM y
libera la GPU.** Si un modelo de 2,6B no llega, dilo con datos (turnos, tool calls,
motivo); no fuerces el resultado ni debilites las pruebas.

Informe: `doc/droid-re/report-codex-lfm25-main.md` en `/home/orlando/Desktop/factory`
(qué portaste y qué no, archivos, comandos exactos, tabla de corridas, qué queda abierto).

---

## Tarea 3 — Codex: SDLC fase 2 (después de la Tarea 1)

Rama: `git switch -c feat/sdlc-fase2 integ/sdlc-connectors` (si el usuario ya la
fusionó, desde `main`). Un commit local por pieza, sin push.

Objetivo: replicar en fab, **a partir del comportamiento documentado**, cuatro piezas
de la Software Factory de Factory: Triage, Automations, AutoWiki y Monitor.

### Fase 0 — investigación (antes de escribir código)

Carga el skill `fab-referencias` y usa sus fuentes:

- **Droid con REA** (MCP `rea`): sobre `/home/orlando/Desktop/factory/Factory-0.205.0 Setup.exe`
  o la evidencia de `doc/droid-re/rea-evidence/`, observa cómo funcionan triage,
  automations (poller, crons, disparadores por evento), wiki y monitor: estados,
  entradas, salidas y eventos. Empieza por triage. **Solo comportamiento**: no copies
  código recuperado, no leas `doc/droid-re/bundle-*` ni prompts capturados; los
  prompts los escribes tú.
- Doc pública: `doc/droid-re/docs-md/pages/software-factory/{triage,automations,incident-response}.md`, `wiki/*.md`.
- ESF (MIT; se puede adaptar citando el origen): `internal/triggers/cron.go`,
  `internal/config/triggers.go`, `docs/issue-triage-demo.md`, `docs/workflows.md`.
- Warp (AGPL; solo diseño): `crates/cloud_object_models/src/scheduled_ambient_agent.rs`.

Entregable: `docs/design-sdlc-fase2.md`. Para cada pieza: el comportamiento
observado (con su fuente: herramienta REA y evidencia, o ruta de la doc), el diseño en
fab (tablas del store, comandos, eventos) y lo que queda fuera. Va en su propio commit.

### Fase 1 — piezas (en este orden, un commit cada una)

1. **Agente de triage.** Lleva un signal `new` a `triaged` (crea el change),
   `duplicate` (lo enlaza al signal o change original) o `ignored`, siempre con
   motivo. Lo ejecuta el pool como una actividad más; en las pruebas, con el agente
   `fake`. Comando: `fab triage --auto <slug>`. Puede apoyarse en Jev para elegir
   modelo, solo si no añade dependencias.
2. **Automatizaciones persistentes.** Una tabla de automatizaciones (cron con zona
   horaria y disparadores por evento del store: `signal.created`, `change.implemented`,
   `validation.failed`…) que encolan actividades. Un proceso `fab daemon` hace el poll
   sin duplicar ejecuciones aunque haya dos instancias (lease en SQLite), con parada
   limpia y TTL. Comandos: `fab automation add|list|pause|resume|rm|runs`. Cron: parser
   propio con pruebas (minuto, hora, día, mes, día de la semana, listas, rangos, pasos).
3. **AutoWiki.** `fab wiki generate <slug>` genera o actualiza páginas Markdown del repo
   del workstream (arquitectura, módulos, cómo ejecutarlo) en un directorio
   configurable, con un agente de solo lectura. El refresco es una automatización
   (`change.merged` o cron). Sin visor web en esta ronda.
4. **Monitor.** `fab monitor <slug>` muestra la salud de la fábrica a partir del store
   (actividades fallidas o atascadas, workers caídos, validaciones en fail,
   automatizaciones que fallan) y, si se pide, abre un signal de incidente cuando se
   cruza un umbral, sin duplicarlo.

Reglas: las de la ronda anterior (`doc/droid-re/task-ronda-sdlc-conectores.md`,
§ «Reglas comunes»). Bun + TypeScript, archivos de menos de 500 líneas, sin
dependencias nuevas, mensajes de CLI en español. Ningún test usa red, Jira, GitHub ni
modelos reales. `src/connectors/types.ts` no se modifica.

Validación: `bun test --max-concurrency=4` con 0 fallos, `bunx tsc --noEmit`,
`git diff --check`.

Informe: `doc/droid-re/report-codex-sdlc-fase2.md` en `/home/orlando/Desktop/factory`
(por pieza: qué hace, archivos, comandos para reproducirlo y qué queda abierto).

Si la fase 0 muestra que alguna pieza no cabe en esta ronda, implementa las que quepan,
en orden (triage y automatizaciones primero), y dilo en el informe.
