# ADR-0001: Harness de investigación delgado, fuera de Store, que compone y adopta

Estado: propuesto (v0.2, reescrito tras refutación) · Fecha: 2026-10-31 · Capa principal: C4b · Afectadas: C2, C7

## Contexto
v0.1 decía "no construir, componer dentro de fab como workstream". La refutación mostró que (a) lo que falta (descubrimiento, árbol de experimentos, prerregistro, señales de aprendizaje) no está en fab, llm_wiki ni graft y sí en referencias MIT; (b) v0.1 descartó dream-machine y OpenResearch con premisas falsas; (c) el modelo de datos de fab no admite exploración: `triageSignal` crea siempre un change (`src/store.ts:449`), los tipos de activity son de ingeniería (`src/enums.ts:33`) y una `investigation` completada encola `implementation`.

## Decisión
- Construir un **orquestador CLI delgado** en `scripts/ideas/` (TS/Bun), fuera de `Store`. Solo toca la máquina de estados de fab al final, para abrir un change de integración (Gate 3).
- **Adoptar con pin (ADR-0005)**: esquema de ledger de 10 columnas y señales de dream-machine; regla de nodo congelado de OpenResearch como esquema; envoltorio `<untrusted-source>` de hyperresearch; cualificación de ESF.
- **Reutilizar**: llm_wiki (ingesta), graft, hyperresearch/agent-reach (barrido), `improve.ts`, gates de fab.
- Deuda explícita, con dueño: vigilancia de fuentes (ADR-0003), árbol de experimentos (ADR-0003), prerregistro (ADR-0003), señales de aprendizaje (ADR-0003), runner de dos builds de fab (ADR-0004).

## Alternativas
- **Workstream dentro de Store** (v0.1): requiere nuevos tipos de activity y estados de resultado; contamina la BD. Rechazado.
- **Adoptar dream-machine entero**: su motor es un compilador de prompt + toolkit Node; el ejecutor puede ser fab. Se adopta su ledger; el compilador no aporta mientras haya un solo repo objetivo. Reabrir si se aplica el ciclo a varios repos.
- **Adoptar OpenResearch (`orx`) como herramienta de ámbito `investigacion`**: evaluar por Loop B; no como runtime de fab.
- **deer-flow**: se copia procedencia y contrato de informe de subagente; el runtime duplica a fab.

## Criterio de revisión
2026-12-15 o 10 ciclos, lo que llegue antes, con tres números: ciclos completados, % `INCONCLUSIVE` por falta de corpus o runner, horas humanas por ciclo.
