# dream-machine-ledger: formato y verificación del ledger de ideación

Estado: candidato
Fecha: 2026-10-31 · base_sha: `2bed96f` · Pin: `third_party/dream-machine/UPSTREAM.json` (ruvnet/dream-machine@3fc3222, MIT, código copiado)
Código: `third_party/dream-machine/ledger/` · Uso: `docs/research/ledger.md`, `tests/provenance.test.ts` · Evidencia: `evidence/dream-machine-ledger-2026-10-31/`

## Qué es
Parser, render, verificación y señales de aprendizaje del ledger de 10 columnas de dream-machine (ADR-0003: adoptar, no reescribir). `index.ts` es idéntico al upstream y el lint comprueba su sha256. Los tests llevan dos parches, registrados en `local_patches`.

## Medido
- Los 57 tests upstream corren en Bun 1.3.14 sin vitest (pendiente #2 de `REVISION.md`): `tests/third-party-ledger.test.ts`.
- `tests/provenance.test.ts`: 4 pass y 0 fail. Incluye que `docs/research/ledger.md` pase `verifyLedger`.
- Prueba negativa, hecha a mano y no automatizada: con el commit del pin de ESF alterado y `index.ts` modificado, el lint falla en los dos casos.

## No medido
- Las señales de aprendizaje (`learningSignals`, `duplicateDirections`) sobre un ledger real de fab: todavía no hay filas.
- Si las convenciones de columnas de fab (capa en Deep, tier en Effect, hashes en Witness) bastan para el intake y la deduplicación del ciclo.

## Gates pendientes
- [ ] Primer ciclo real con fila en el ledger y señales calculadas.
- [ ] Decidir si `scripts/ideas/` usa `appendRow` del upstream o escribe la fila a mano.
- [ ] Revisión del operador antes del merge (ADR-0005).
