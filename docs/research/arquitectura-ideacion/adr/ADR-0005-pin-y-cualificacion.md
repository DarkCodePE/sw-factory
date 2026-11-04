# ADR-0005: Pin de upstream y registro de cualificación por feature

Estado: propuesto (v0.2) · Fecha: 2026-10-31 · Capa principal: C6 · Afectadas: C8, licencia

## Contexto
ESF dejó `third_party/harness2/{LICENSE,NOTICE,UPSTREAM.json}` y `release/qualification/harness2-integration-2026-10-19.md` ("implemented candidate; production adaptation disabled and unqualified", gates pendientes, evidencia JSON). Su lint de release Python no verifica la firma (`scripts/release_qualification.py:65`, `bool(signature)`); la promoción en runtime sí verifica Ed25519 (`qualification.go:240-253`). El PR #43 se mergeó a las 14:10 y la única revisión (bot) llegó a las 14:19, con 2 P1 que siguen abiertos en `d901657`. En fab, `src/improve.ts:2` adapta ESF con solo un comentario.

## Decisión
- Pin `third_party/<upstream>/UPSTREAM.json`: `repo`, `commit` (40 hex), `license_spdx`, `use_rule` (`idea` o `vendored`) y `not_imported`.
  - Con `idea`: `uses[]` con `src`, `adapted_from` y `candidate_id`.
  - Con `vendored`: `LICENSE` obligatorio y `vendored[]` con el sha256 de cada archivo sin parchear, más `local_patches`.
- Registro `docs/qualification/<id>-<fecha>.md` (`candidato | cualificado`, `base_sha`, pin, medido / no medido, **gates pendientes**) + `evidence/<id>-<fecha>/*.json` con salida cruda, exit code y hash.
- Lint `tests/provenance.test.ts`. Falla si:
  - hay un `Idea: ext/<repo>/...@sha` sin pin o con otro commit;
  - un archivo copiado difiere del upstream sin estar en `local_patches`;
  - falta `LICENSE`;
  - un registro no tiene `Estado:` ni `## Gates pendientes`;
  - un registro `cualificado` no tiene evidencia;
  - el ledger no pasa `verifyLedger`.

  *Flag activo por defecto sin `cualificado`*: pendiente hasta que exista un registro de flags.
- **La revisión ocurre antes del merge** y no hay merge con hallazgos críticos abiertos.
- Aprobación del operador ligada al hash del registro (un solo operador: no aplica autor ≠ revisor).
- Primer caso: aplicar a `src/improve.ts` y a la adopción del ledger de dream-machine.
