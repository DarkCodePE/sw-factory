# Ola 1 — resultado (2026-10-30)

Fusionada en `main` local como `0db0893` (árbol = `integ/ola1@0b8253a`). Sin push.

## Ramas
| Rama | Autor | Fichas |
| --- | --- | --- |
| `fab/research-ola1-codex` (`ccc9564`, `bfe6ed3`, `f0c4195`) | codex | 06 BLOCKED, 09 actor y motivo, 02 integridad |
| `fab/research-ola1-agy` (5 commits + 4 de revisión 1) | agy | 07 exclusión por change, leases, aborto real |
| `integ/ola1` (`9e63bca`, `0b8253a`) | Claude | resolución de choques; cancelar pendientes al cerrar change |

Revisión 1 a agy (`tasks/review-ola1-agy-r1.md`): `detached` dejaba al agente vivo tras Ctrl-C o `kill -9` del pool → dos escritores tras vencer el lease. Corregido con manejadores de señal, `agent_pgid` y muerte del grupo antes de reencolar.

Defecto hallado en la medición (`0b8253a`): tras `fab reject`, los validadores pendientes del change cancelado quedaban `pending` para siempre y `fab run --once` no llegaba a idle (dos pools colgados 20 min). `setChangeStatus` cancela los pendientes al pasar a estado terminal.

## Gate
| Prueba | Resultado |
| --- | --- |
| `bun test` | 805 pass, 0 fail (main previo: 762) |
| `tsc --noEmit` | limpio |
| demo 06/02 con `fab` real (script de codex) | blocked en inbox; GATE_TAMPERED; retry re-bloquea; gate allow auditado desbloquea |
| Ctrl-C a `fab run` (`scratchpad/sigint-test.sh`) | pool y agente mueren |
| `kill -9` del pool con agente que escribe (`scratchpad/ola1-gate/kill9-test.sh`) | huérfano muerto antes de reencolar; 0 escrituras |

## Carreras, `scripts/e2e/ola0-races.sh` de opencode, n=10 (media por corrida)
| Métrica | main `7783845` | ola 1 `0b8253a` |
| --- | --- | --- |
| activities reclamadas ≥2 veces | 3.8 | 0.2 (secuenciales, tras SQLITE_BUSY) |
| conflictos de custodia "is not held by" | 3.4 | 0 |
| pares solapados en el mismo worktree | 6.0 | 0 |
| validador completa tras `fab reject` | 2.0 | 0 |
| escrituras tras `reject` | 4.2 intentos | 0 |
| SQLITE_BUSY | 1.0 (pool muere) | 0.3 (capturado; quema 1 reintento) |

Medido por Claude con el instrumento de opencode (no independiente).

## Pendiente
- `SQLITE_BUSY` bajo contención de dos pools: ya no mata el pool, pero falla la activity y consume un reintento. Candidato para ola 2.
- `pre-commit` de D5 no verificable con el agente fake.
- Changes anteriores a la migración toman como `base_sha` el HEAD de su worktree.
- Codex: cuota semanal al 12 %.
