# Ola 2 — resultado (2026-10-30)

PR #29 (`feat/esf-ola-2`, `80b7085`, abierta y fusionable). Árbol = `integ/ola2`.

| Rama | Autor | Tareas |
| --- | --- | --- |
| `fab/research-ola2-codex` (`1cde38a`, `68d09f0`) | codex | 04 manifest y merge recuperable |
| `fab/research-ola2-agy` (`3297e74`, `69f33d3`, `b6b5f3f`) | agy | F1 SQLITE_BUSY, 03 threatmon, 08 sonda |
| `fab/research-ola2-opencode` (`a016b63`, `6ebaa3d`, `0c393b9`) | opencode | agents-verify, F2, F3 |
| `integ/ola2` | Claude | choques con 04; `withRetry` atómico (IMMEDIATE, 4 intentos); mensaje de merge sin commits |

## Gate
- `bun test` 841 pass, 0 fail; `tsc` limpio.
- Carreras n=10 (`scripts/e2e/ola0-races.sh`): `database is locked` 0.3 → 0; pares en el mismo worktree 0; escrituras tras reject 0; 0.2 reclamaciones repetidas = reintentos secuenciales de un validador que el script hace fallar a propósito.
- `fab` real: 03 cuarentena con `nmap` (inbox, merge rechazado, manifest `quarantined`); 04 manifest y merge recuperado tras `kill -9` (codex); F3 0 marcadores frente a 1 en `29d4dd3` (opencode).

## Incidencias
- Codex y opencode terminaron sin relevo; opencode se cortó dos veces y siguió con `--continue`.
- Agy quedó 10 min en un `grep -r` sobre todo `factory`; lo corté y le pedí acotar al worktree.
- Defecto de integración en F1: `withRetry` repetía escrituras parciales; corregido con test (`tests/store-retry.test.ts`, falla sin la corrección).

## Pendiente
- 03: falsos positivos sobre ≥30 logs completos de 04.
- 08: escribir `{reachable, decided}` en el `run.json`.

## Cierre (2026-10-31) — PR #30
- Threatmon medido con `scripts/e2e/threatmon-fp.ts` sobre transcripciones reales de codex: ajuste 8/40 → 0/40, reserva 0/30 → 0/30, adversarias 8/10 → 10/10, ocultas 3/5 → 5/5 (la clase python se le describió a agy en la revisión 1). Ajuste hecho por agy en dos rondas.
- Sonda 08 en `run.json` (`egressProbe`): Claude Code Sonnet como relevo de opencode (cuota gratuita agotada en todos los modelos). Corrección de integración: un reintento ya no reutiliza la sonda del intento anterior.
- Scripts e2e de la ola 0 (D5, H2, carreras) entran al repo.
- `bun test` 861 pass, 0 fail.
- Limpieza: 16 worktrees y 14 ramas locales de las olas borrados (todo preservado en `main` o en PR #30); paneles de herdr de las olas cerrados; 16 servidores MCP huérfanos de sesiones de codex ya cerradas detenidos.
