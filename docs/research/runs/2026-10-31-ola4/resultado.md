# Ola 4 — resultado (2026-10-31)

PR #33 (`feat/esf-ola-4`): 05 perfiles inmutables por digest, fase 1 (Claude Code Sonnet; codex reservado por cuota).
- 892 tests, 0 fail en worktree limpio; `tsc` limpio. Precondición byte a byte con golden de `main`.
- Smoke real: export → import idempotente → `--profile`; digest inválido rechazado.
- Medición `claude` suscripción, 60 corridas (3 tareas × 10 pareadas): éxito 100 % ambos brazos, duración 56,2 vs 56,6 s, diff 28,0 vs 28,9. Guardianas cumplidas; métrica primaria (varianza ≤ 0,8) no demostrada (tareas fáciles, n pequeño). Detalle: `report-sonnet.md`.
- Fase 2 pendiente: cualificación estadística, rollout, rollback, revisor ≠ autor.
