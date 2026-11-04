# Ledger de ideación

Una fila por ciclo, **siempre** (también `HALT: budget`). Formato y verificación: `@dream-machine/ledger` copiado en `third_party/dream-machine/` (ADR-0003). `bun test tests/provenance.test.ts` lo verifica.

Convenciones de fab sobre las 10 columnas de dream-machine (sin columnas extra, para no romper `verifyLedger`):
- Fuera de la tabla no uses el carácter barra vertical: el parser upstream cuenta como fila toda línea que lo contenga.
- **Deep**: capa `C0`–`C9` (tabla de `docs/research/design-loops-investigacion.md`).
- **Verdict**: `ACCEPT`, `REJECT` o `INCONCLUSIVE`. El tier va al inicio de **Effect**: `T1 candidato: …`, `T2 cualificado: …`, o la razón del INCONCLUSIVE.
- **Witness**: `hyp:<sha8> ev:<sha8>`. Hash de la hipótesis prerregistrada (antes del Probe) y de la evidencia.
- **Issue** y **PR**: id del change de fab (`chg_…`) o `NONE`.

| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-03 | C4b | 2026-11-03-C4b-busqueda-acotada-01: ¿Reduce el coste por tarea del worker añadir a su prompt de implementación que localice con búsqueda acotada (Grep y Read por rangos) antes de editar, sin perder éxito? | NONE | NONE | yes | INCONCLUSIVE | T0 INCONCLUSIVE(T0 solo humo; candidato +8,5 % costUsd (0,0242 frente a 0,0223 USD, n=5 tareas × 1), contrario a la predicción −20 %; éxito 5/5 en ambos; 1.er crítico (Codex) no halló el canary, 2.º (Sonnet) sí) | hyp:9fc5bb65 ev:2a5a7398 | NONE |
