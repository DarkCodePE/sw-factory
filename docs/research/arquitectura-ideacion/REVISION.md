# Revisión de v0.1 → v0.2

Críticos: **Fable 5.1** (refutación) y **agy / Gemini 3.8 Flash** (viabilidad). Informes completos (temporales) en el scratchpad de la sesión: `refutacion-fable.md`, `critica-agy.md`. Los hallazgos marcados ✔ se verificaron en el código por el integrador antes de aceptarlos.

| Hallazgo | Fuente | Disposición | Dónde |
|---|---|---|---|
| El ciclo no cabe en `Store`: triage crea change, activity kinds de ingeniería, `investigation` encola `implementation` ✔ `src/store.ts:449`, `src/enums.ts:33` | agy CRIT-01 | **Aceptado**: orquestador CLI fuera de Store | ADR-0001, ARQ §2 |
| v0.1 descartó dream-machine y OpenResearch con premisas falsas | Fable A1, A4, C4, C5 | **Aceptado**: veredictos corregidos | ARQ §8, ADR-0001 |
| ADR-0003 reimplementa el ledger que dream-machine ya publica | Fable A2 | **Aceptado**: adoptar esquema y señales (portar tests si no corre en Bun) | ADR-0003 |
| Faltan descubrimiento, árbol de experimentos, prerregistro, señales | Fable A3, B1 | **Aceptado** | ADR-0003, ARQ §5 |
| Cola de borradores sin revisar (ledger real de dream-machine 0/30) | Fable A6 | **Aceptado**: límite de changes en Gate 3 | ADR-0003 |
| Sin priorización ni método para hipótesis buenas | Fable B2, B4 | **Aceptado**: backlog puntuado, rotación, receipt + mecanismo + predicción | ADR-0003 |
| Sin coste por corrida; portar `Qualify` falla siempre ✔ `src/improve.ts:107` | Fable B3, agy CRIT-08 | **Aceptado**: coste como prerrequisito; `usd_max` obligatorio | ADR-0004, ARQ §5-6 |
| Sesgo de confirmación: sin crítico ni hipótesis congelada | Fable B5, D4 | **Aceptado**: prerregistro con hash + goldfish | ADR-0003 |
| Worktree ≠ aislamiento; Paper2Agent corre con credenciales y red | Fable B6, D7 | **Aceptado**: fuera del flujo automático | ADR-0006 |
| Prompt injection no tratada | Fable B7 | **Aceptado**: ADR nuevo | ADR-0007 |
| MCP de llm_wiki bloqueado por `--unshare-net`; requiere app abierta ✔ `src/agent/mcp-sandbox.ts:30` | Fable B8, agy CRIT-02 | **Aceptado con otra solución**: agentes leen `wiki/*.md` como archivos RO; MCP opcional | ADR-0002 |
| `src/agent/mcp.ts` no es un registro; adaptadores CLI no leen config de fab ✔ `src/agents.ts:65` | agy CRIT-03 | **Aceptado**: ya no se depende del MCP | ADR-0002 |
| `improve.ts` no mide cambios del motor de fab | agy CRIT-04 | **Aceptado**: runner de dos builds como prerrequisito; hasta entonces solo perfil/prompt/skill | ADR-0004 |
| T2 paraliza el sistema | agy CRIT-05, §5.1 | **Aceptado parcialmente**: `ACCEPT-candidato` con T1 y flag apagado; T2 solo para activar por defecto | ADR-0004 |
| T1 tampoco existe (2 clusters, sin `group`) | Fable B9 | **Aceptado** | ADR-0004, ARQ §6 |
| No hay daemon ✔ `src/cli.ts:127` | agy CRIT-06, Fable B11 | **Aceptado**: timer de systemd --user | ADR-0003 |
| `integrity.ts` no se usa en `improve.ts` ✔ (0 referencias) | agy CRIT-07 | **Aceptado**: prerrequisito | ADR-0004 |
| Gate `experimento_autorizado` eliminado | Fable D1 | **Aceptado**: restaurado | ADR-0003, ARQ §5 |
| Dos regímenes estadísticos | Fable D2 | **Aceptado**: receta §3 = T1, ESF = T2 | ADR-0004 |
| Presupuesto no decidido | Fable D3 | **Aceptado**: obligatorio | ARQ §5 |
| Referencias sin `archivo:línea@sha` ni entrada en registry | Fable D5 | **Aceptado, pendiente**: Loop B mínimo de 5 repos antes de aprobar | ARQ §8 |
| `docs/research/analisis/` contradice ADR-0002 | Fable D6 | **Aceptado**: excepción explícita | ADR-0002 |
| Matiz firma ESF (lint vs runtime) y PR #43 revisado después del merge | Fable C2, C3 | **Aceptado** | ADR-0005, ARQ §8-9 |
| hyperresearch sí tiene UI, grafo y PDF | Fable C6 | **Aceptado** | ADR-0002 |
| `improve.ts` fase 1 es cualificación ESF, no PPC | Fable C8 | **Aceptado** | ARQ §8 |
| Reemplazar llm_wiki por carpeta markdown en git | agy §4 | **Rechazado**: se pierde MinerU, caption y UI; la lectura por archivos ya resuelve el modo headless | ADR-0002 |
| Video es una distracción | agy CRIT-09 | **Parcial**: segunda clase, vía agent-reach; sin script nuevo por ahora | ADR-0002 |
| Eliminar la prohibición de ACCEPT sin T2 | agy MVC | **Parcial**: ACCEPT-candidato sí, activar por defecto no | ADR-0004 |
| MinerU en la nube podría exfiltrar fuentes de clientes | Fable E | **Registrado** como riesgo del flujo A | ARQ §7 |

## Pendiente antes de aprobar v0.2
1. Loop B mínimo (ficha + entrada en `registry.json` con `last_sha` y evidencias con línea) para dream-machine, OpenResearch, Paper2Agent, deer-flow y harness2.
2. ~~Verificar que `@dream-machine/ledger` corre en Bun~~ **Hecho (2026-10-31)**: 57/57 en Bun, copiado en `third_party/dream-machine/`.
3. Confirmar la ruta del proyecto fab-research y el montaje `--ro-bind` en bwrap.
4. Medir coste medio por corrida en `bench/ola3` para dimensionar T2.
