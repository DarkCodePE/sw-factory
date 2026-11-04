# ADR-0003: Ciclo con vigilancia, prerregistro, gate de gasto y ledger adoptado

Estado: propuesto (v0.2) · Fecha: 2026-10-31 · Capa principal: C2 · Afectadas: C3, C7

## Contexto
dream-machine corre una hipótesis falsable por ciclo con ledger obligatorio y "evaluation is not promotion". Su ledger real muestra el modo de fallo: "27 open drafts, 0/30 merged… #49+#59 independently duplicate the same fix" (`ext/dream-machine/docs/dream-cycle/LEDGER.md`). v0.1 no tenía descubrimiento, priorización, prerregistro, crítico, presupuesto ni gate antes de implementar (el diseño v0.2 §9 sí exige `experimento_autorizado`).

## Decisión
- **Vigilancia** semanal desde `watch_sources` (registry.json): feeds arXiv por categoría, HF daily papers, releases de repos `watch: true`. Tope `fuentes_max`.
- **Backlog** `docs/research/backlog.json` con score (impacto × confianza / esfuerzo) y capa; rotación: no dos ciclos seguidos en la misma capa sin evidencia nueva.
- **Límite de cola**: con ≥ N changes `ideas` esperando Gate 3 (inicial N = 3), el ciclo no abre change; solo registra.
- **Una hipótesis por ciclo**, con limitación medida (receipt), mecanismo causal, predicción numérica, métrica y guardianas de la tabla C0–C9. **Prerregistro**: su hash va al ledger antes del Probe; cambiarla = ciclo nuevo.
- **Gate `experimento_autorizado`** del operador, con `usd_max` y `horas_max`, antes de implementar.
- **Crítico goldfish** (modelo distinto del implementador) antes de abrir change.
- **Ledger** `docs/research/ledger.md`: esquema de 10 columnas de dream-machine **sin columnas extra** (`verifyLedger` exige 10). Capa en *Deep*, tier al inicio de *Effect* y `hyp:<sha8> ev:<sha8>` en *Witness*. Fila **siempre**, incluso `HALT: budget`. `@dream-machine/ledger` está copiado tal cual en `third_party/dream-machine/` y sus 57 tests corren en Bun (registro `docs/qualification/dream-machine-ledger-2026-10-31.md`).
- **Árbol de experimentos**: cada medición es un nodo (código + comando + entorno + resultado) que no se edita una vez respondido; reparar o ramificar crea nodo nuevo (regla de OpenResearch).
- Resultados: `ACCEPT-candidato | ACCEPT-cualificado | REJECT | INCONCLUSIVE(razón)` (ADR-0004).
- **Cadencia**: timer de `systemd --user`; `fab daemon` no existe (`src/cli.ts:127`).

## Consecuencias
+ Ideas rechazadas o duplicadas no vuelven a gastar.
+ El gasto lo autoriza el operador por ciclo.
− Una interrupción al operador por ciclo (gate de gasto) además de Gate 3.
