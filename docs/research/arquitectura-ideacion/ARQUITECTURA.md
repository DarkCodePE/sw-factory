# Arquitectura de investigación e ideación de fab

Estado: **borrador v0.2** (2026-10-31). v0.1 fue refutada por Fable 5.1 y criticada por agy; cada hallazgo y su disposición están en [REVISION.md](REVISION.md). ADR: [adr/](adr/).

## 1. Problema

| Flujo | Pregunta | Estado hoy |
|---|---|---|
| **A. Operación** | Entra un ticket: ¿qué contexto necesita el agente? | graft para código; sin memoria entre tareas; sin docs del cliente |
| **B. Ideación** | ¿Qué papers, repos y artículos pueden **mejorar fab**, y cómo se convierte una idea en feature con evidencia? | Diseño Loop A/B (`docs/research/design-loops-investigacion.md` v0.2), `registry.json`, `src/improve.ts` fase 1, `bench/ola3`. Sin descubrimiento, sin ciclo recurrente, sin ledger, sin cualificación, sin política de inyección |

Este documento resuelve **B**. Requisito del operador: tomar papers, repos, artículos, PDF, imágenes y videos y **proponer mejoras orientadas a fab**, reutilizando llm_wiki, graft y la memoria analizada.

## 2. Decisión principal

**Sí, un harness de investigación propio, pero delgado: un orquestador CLI fuera de la máquina de estados de fab que compone piezas existentes y adopta, con pin, piezas MIT de las referencias** ([ADR-0001](adr/ADR-0001-componer-no-construir.md)).

- **Fuera de `Store`**: en fab, triagear una señal crea siempre un change (`src/store.ts:449`), los únicos tipos de activity son de ingeniería (`src/enums.ts:33`) y una `investigation` completada encola una `implementation`. Meter la exploración ahí llenaría la BD de changes basura. El ciclo vive en `scripts/ideas/` y **solo** crea un change de fab cuando hay algo que integrar.
- **Adoptar, no reescribir**: esquema de ledger de 10 columnas y señales de aprendizaje de dream-machine (`ext/dream-machine/packages/ledger/src/index.ts:276-589`), regla de nodo congelado del árbol de experimentos de OpenResearch (`agent-skills/orx-experiment-tree/SKILL.md`), envoltorio `<untrusted-source>` de hyperresearch (`src/hyperresearch/core/hooks.py:363-367`), cualificación de ESF (`internal/harnessprofile/qualification.go`).
- **Reutilizar**: llm_wiki (ingesta), graft (repos), hyperresearch y agent-reach (barrido), `improve.ts` (medición), Gate 3 (integración).

## 3. Vista general

```
 0 VIGILANCIA          BÓVEDA                       CICLO (scripts/ideas/, fuera de Store)              INTEGRACIÓN
 ────────────          ──────                       ─────────────────────────────────────              ───────────
 watch_sources ──┐                                  1 Intake + dedup (ledger, registry)
 (arXiv, HF,     ├─▶ <proyecto llm_wiki>/           2 Priorizar (backlog puntuado, rotación por capa)
 releases ext/)  │    raw/sources/  ◀── fuentes     3 Hipótesis + PRERREGISTRO (hash en ledger)
 hyperresearch ──┤    wiki/*.md     ──▶ lectura RO  4 ◆ GATE experimento_autorizado (operador, presupuesto)
 agent-reach ────┤    (llm_wiki ingiere:            5 Probe  (lector: solo receta+spec, fuentes = untrusted)
 operador ───────┘     MinerU, caption, grafo)      6 Medir  (implementador en sesión limpia; improve.ts)
 repos ext/ ─────── graft                           7 Crítico goldfish (receta + resultado)
                                                    8 Veredicto ACCEPT|REJECT|INCONCLUSIVE + ledger SIEMPRE
                                                    9 Reflejar: página trust:agent en llm_wiki       ──▶ ◆ change fab (Gate 3)
```

## 4. Componentes y dueños

| Capa | Componente | Dónde | Estado |
|---|---|---|---|
| Ingesta | llm_wiki proyecto **fab-research** (MinerU, caption de imágenes, grafo, UI del operador) | `~/Desktop/llm_wiki_v2` | Existente |
| Lectura de agentes | **archivos** `<proyecto>/wiki/*.md` montados solo-lectura, buscados con `rg`; envueltos como no confiables | sandbox de fab | Nuevo, mínimo ([ADR-0002](adr/ADR-0002-llm-wiki-boveda-unica.md)) |
| Escritura de agentes | `<proyecto>/raw/sources/agentes/` (llm_wiki la ingiere); páginas con `trust: agent` | llm_wiki | Nuevo, mínimo |
| MCP de llm_wiki | **opcional**, solo sesiones interactivas con la app abierta; nunca `llm_wiki_chat` | config del CLI del agente | Opcional |
| Vigilancia | `watch_sources` en `registry.json` + barrido semanal (hyperresearch light / agent-reach) | `scripts/ideas/watch` | Nuevo |
| Backlog | `docs/research/backlog.json` (score = impacto × confianza / esfuerzo, capa C0–C9) | fab | Nuevo |
| Ledger | `docs/research/ledger.md`, 10 columnas de dream-machine (capa en Deep, hashes en Witness), código en `third_party/dream-machine/` | fab | Adoptado ([ADR-0003](adr/ADR-0003-ciclo-una-hipotesis.md)) |
| Medición | `improve.ts` fase 2: coste por corrida, `integrity.ts`, `group` por tarea, regla por tier | fab | Extender ([ADR-0004](adr/ADR-0004-evaluacion-no-es-promocion.md)) |
| Integración | pin `third_party/<x>/UPSTREAM.json` + `docs/qualification/<id>-<fecha>.md` + lint | fab | Nuevo ([ADR-0005](adr/ADR-0005-pin-y-cualificacion.md)) |
| Probe de paper con código | Paper2Agent **fuera del flujo automático** | VM desechable | Manual ([ADR-0006](adr/ADR-0006-paper2agent-solo-probe.md)) |
| Inyección | separación lector / implementador, envoltorio, `trust` | ciclo | Nuevo ([ADR-0007](adr/ADR-0007-fuentes-no-confiables.md)) |
| Lectura de repos grandes | graft + `rg` como herramientas del lector: mapa de ≤ 4 k tokens, consultas acotadas, envoltura del harness (semillas, desambiguación, salida acotada, frescura). Evidencia en `codesearch/` | `scripts/ideas/graft-lector.ts`, `lector-fab.ts` | Aceptado e implementado, fase A ([ADR-0008](adr/ADR-0008-probe-por-tipo-de-fuente.md)) |
| Cadencia | timer de `systemd --user` que ejecuta un ciclo (`fab daemon` no existe: `src/cli.ts:127`) | host | Nuevo, mínimo |

## 5. Contrato del ciclo

Cabecera canónica de `design-loops-investigacion.md` §2, con **`usd_max` y `horas_max` obligatorios**; sin ellos el ciclo no arranca.

0. **Vigilancia** (semanal, independiente del ciclo). Cada fuente nueva entra a `raw/sources/` con url, fecha y hash, y una entrada al backlog con capa sugerida. Tope `fuentes_max`.
1. **Intake.** Deduplicación determinista contra el ledger (señales de dream-machine: dirección repetida ≥ 3 veces → rotar; hipótesis rechazada sin evidencia nueva → descartar).
2. **Priorizar.** Primer candidato del backlog por score; no dos ciclos seguidos en la misma capa salvo evidencia nueva. **Si hay ≥ N changes `ideas` esperando Gate 3, el ciclo no abre change nuevo** (lección del ledger real de dream-machine: "0/30 merged", borradores sin revisar).
3. **Hipótesis + prerregistro.** Requiere: (i) limitación de fab con receipt (métrica, valor, `fab_sha`, comando que la reproduce), (ii) mecanismo causal, (iii) predicción numérica, (iv) métrica primaria y guardianas tomadas de la tabla C0–C9. También registra `tipo_fuente`, `tokens_medidos`, `presupuesto_lectura` y el tope de consultas ([ADR-0008](adr/ADR-0008-probe-por-tipo-de-fuente.md)). El hash se escribe en el ledger **antes** del Probe; cambiarla = ciclo nuevo. Si falta algo → `INCONCLUSIVE(hipótesis incompleta)` sin gastar más.
4. **◆ Gate `experimento_autorizado`.** El operador aprueba hipótesis y presupuesto (restaura el diseño v0.2 §9). Barato: una línea en el inbox.
5. **Probe.** El **lector** lee fuentes (wiki RO, graft sobre `ext/`) y produce **solo** receta y spec. Todo contenido ajeno le llega envuelto como no confiable. Un solo procedimiento con umbral medido ([ADR-0008](adr/ADR-0008-probe-por-tipo-de-fuente.md)):
   - si la fuente cabe en `presupuesto_lectura`, se lee entera;
   - si no, se baja de nivel: repo → subsistema → símbolos y tramos.

   En un repo grande, el lector **localiza y sigue llamadas con búsqueda agéntica** (`rg`, lectura de tramos) dentro del presupuesto, con graft como complemento (mapa de ≤ 4 k tokens, `skeleton` y `callers` acotados, `--no-refresh`). Medido el 2026-11-02 en opencode (TypeScript) y deer-flow (Python): la búsqueda libre acertó 5 de 5 en ambos, con ~42 k y ~18 k tokens; graft `ask` encontró el archivo entre los 5 primeros en 2 de 9 y en 4 de 9. Herramientas en `scripts/ideas/graft-lector.ts` (núcleo independiente de fab) y `lector-fab.ts` (adaptador). Las aristas ausentes no prueban nada ante el crítico.
6. **Medir.** El **implementador** arranca en sesión limpia, sin fuentes, solo con la spec; implementa detrás de flag apagado en `fab/ideas-<id>`; `improve.ts` mide según el tier.
7. **Crítico goldfish** (otro modelo, paquete de §8 del diseño) revisa receta y resultado.
8. **Veredicto** según §6 y **fila de ledger siempre**, también con `HALT: budget`.
9. **Reflejar.** Página `trust: agent` en `raw/sources/agentes/`; `registry.json` y backlog actualizados. Si hay algo que integrar: change normal de fab con el registro de cualificación → Gate 3.

## 6. Medición: qué puede decidir cada tier

| Tier | Contenido | Regla | Puede emitir |
|---|---|---|---|
| T0 humo | 5 tareas × 1, agente `fake` o barato | ¿rompe algo? | `REJECT` solo por guardiana determinista (integridad, escape de sandbox, licencia) |
| T1 filtro | `bench/ola3` + casos nuevos; receta §3: n_runs ≥ 10 pareadas, IQR | Mejora con IQR no solapado | `INCONCLUSIVE(filtrado)` o `ACCEPT-candidato` |
| T2 cualificación | ≥100 tareas intactas, ≥10 clusters, × 3, bootstrap ESF | ganancia ≥ 5 pp y cota inferior del IC bilateral 95 % > 0 | `ACCEPT-cualificado` / `REJECT` |

Dos clases de integración, para no paralizar el sistema mientras no existe T2:
- **`ACCEPT-candidato`** (T1): se integra con flag **apagado por defecto**, estado `candidato` en el registro y gates pendientes escritos. Es lo que hizo ESF con Harness2 ("implemented candidate; production adaptation disabled and unqualified").
- **`ACCEPT-cualificado`** (T2): única vía para **activar por defecto** una feature o cambiar el comportamiento por omisión.

Prerrequisitos: coste por corrida **hecho el 2026-10-31** (`ArmResult.costUsd`, `src/improve.ts:110`; solo `claude` lo reporta, el resto queda NULL). Siguen ausentes: `integrity.ts` en `runArm` (0 referencias), `group` en `SuiteTask` (`src/improve.ts:15`), `repeated-baseline`, y un runner que compare **dos builds de fab** (hoy `improve.ts` solo compara perfiles). Hasta tener ese runner, el ciclo solo puede medir ideas de **perfil, prompt o skill**; las ideas de motor quedan en `INCONCLUSIVE(sin runner)`.

## 7. Interfaz con el flujo A (operación)

Mismas piezas, proyectos separados: graft para código; un proyecto llm_wiki por cliente (nunca mezclado con fab-research); memoria de agente con el diseño de `agent-memory` (decisión aparte); ontología solo si el cliente exige consultar datos de negocio. Riesgo a revisar: si MinerU usa la API en la nube, las fuentes de clientes salen de la máquina; en el flujo A usar MinerU local o pdfium.

## 8. Referencias y veredicto (corregido)

| Repo | Veredicto |
|---|---|
| dream-machine (MIT) | **Adoptar** esquema de ledger y señales (portar tests si `@dream-machine/ledger` no corre en Bun); copiar disciplina de ciclo y prerregistro (ADR-0009 de dream-machine). Su `/schedule` es un paso manual y sus backends de evaluación son opcionales (`ADR-0001-dream-machine-engine.md:98-101,140-143`) |
| ESF (MIT) | **Adoptar** cualificación, pin y registro con gates pendientes. Lección: el PR #43 se mergeó **antes** de que llegara la única revisión (bot, 9 min después) y sus 2 P1 siguen abiertos; el lint de release no verifica la firma, la promoción en runtime sí (`qualification.go:240-253`) |
| Harness2 (Apache-2.0) | Candidato a medir con este ciclo. `improve.ts` fase 1 es la **cualificación de ESF**, no Propose–Probe–Compose |
| hyperresearch (MIT) | **Usar** para barrido y **adoptar** su envoltorio de fuentes no confiables. Tiene UI, grafo y PDF completos; llm_wiki se elige por caption de imágenes, MinerU y proyectos por cliente |
| OpenResearch (MIT) | **Copiar** árbol de experimentos y regla de nodo congelado como esquema. Es un harness genérico de investigación (literatura, hipótesis, experimentos), con demo de ML. Evaluar `orx` como herramienta de ámbito `investigacion` |
| deer-flow (MIT) | **Copiar disciplina**: procedencia por productor (`deerflow_extension_api/provenance.py`) y contrato de informe de subagente. No adoptar runtime |
| Paper2Agent (MIT) | Manual, en VM desechable |

Todas deben entrar en `registry.json` con `archivo:línea@sha` (Loop B mínimo) antes de aprobar este documento.

## 9. Comparación con el flujo de ESF

| Paso | ESF (caso Harness2, PR #43) | fab v0.2 |
|---|---|---|
| Descubrimiento | Sin rastro en el repo | Vigilancia + backlog puntuado |
| Análisis del upstream | Sin ADR (solo PR #4 tuvo ADR) | Loop B mínimo con `archivo:línea@sha` en `registry.json` |
| Hipótesis | No explícita | Prerregistrada con hash, mecanismo y predicción |
| Autorización para gastar | No visible | Gate `experimento_autorizado` con `usd_max` |
| Instrucciones del agente | Fuera del repo (`.gitignore` excluye `AGENTS.md`) | Versionadas en `scripts/ideas/` |
| Inyección desde fuentes | No tratada | Lector/implementador separados, envoltorio, `trust` |
| Implementación | Reimplementación nativa, sin runtime upstream | Igual, detrás de flag apagado |
| Medición | Suites `esf-improvement-suite/v1`, 4 brazos, ×3, bootstrap | T0/T1/T2; bootstrap solo en T2 |
| Pin y licencia | `third_party/harness2/{LICENSE,NOTICE,UPSTREAM.json}` | Igual + lint |
| Registro | `release/qualification/<feature>-<fecha>.md` con gates pendientes | `docs/qualification/<id>-<fecha>.md` igual |
| Revisión | Bot, después del merge | Goldfish antes del change + Gate 3; sin merge con críticos abiertos |
| Memoria entre ideas | No | Ledger + página en llm_wiki |
| Estado al integrar | "candidate, disabled, unqualified" | `ACCEPT-candidato` igual; `ACCEPT-cualificado` para activar |

Resumen: de ESF se toma lo que hace bien al **final** del flujo (cualificación, pin, registro honesto). El **principio** del flujo (descubrimiento, hipótesis, autorización, inyección) viene de dream-machine, OpenResearch y hyperresearch, porque ESF no lo deja ver.

## 10. Riesgos y no decidido

- Corpus T2: origen y coste (≈ 600 corridas por cualificación; 900 en modo adaptativo). Hasta medir el coste medio por corrida no se sabe si es asumible.
- Runner de dos builds de fab: sin él, solo ideas de perfil, prompt o skill.
- Lectura RO de la bóveda dentro de bwrap: confirmar la ruta del proyecto y montarla con `--ro-bind`.
- Autor = revisor (un solo operador): el goldfish y la aprobación ligada al hash mitigan, no resuelven.
- Calidad del caption de imágenes y de MinerU: sin verificar.
