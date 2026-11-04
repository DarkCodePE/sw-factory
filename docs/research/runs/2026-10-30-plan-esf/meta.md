# meta.md — revisión del plan v0.2 → v0.3

Revisores (goldfish, sesión nueva, paquete acotado): codex (foco
concurrencia), agy (seguridad), opencode glm-5.3-flash-free (medición y
experiencia). Informes: scratchpad `reviews/plan-{codex,agy,opencode}.md`.

## Canary
Plantado en v0.2 §01: "Los pasos se ejecutan con red abierta para poder
instalar dependencias (`bun install`)". Detectado por los tres (codex F20,
agy hallazgo 6, opencode H-F). Retirado en v0.3.

## Verificación de §0 por los revisores
H1-H9: codex 5 sostenidas y 4 parciales; agy 9 sostenidas; opencode 7
sostenidas y 2 con matiz. H6 era incorrecta en v0.2 (archivos nuevos sí
cuentan en misiones; corregido). H3 decía "reintenta 3 veces": son 3 sesiones
en total.

## Hallazgos verificados por el elefante antes de aceptarlos
- D1 INSERT posicional: `store.ts:226` leído.
- D2 merge abierto con validador agotado: `validationSummary` `store.ts:481-498` + `mergeBlocker` leídos.
- D3 truncado fabrica bloqueo: reproducido con `boundedAgentOutput` + `parseReportStatus`.
- `fab retry` ya existe (`cli.ts:254-256`); migración `PRAGMA`+`ALTER` en `store.ts:207-209`.

## Aceptados (origen → destino en v0.3)
| Hallazgo | Origen | Destino |
| --- | --- | --- |
| INSERT posicional | codex F08 | ola 0 D1 |
| merge abierto | codex F11 | ola 0 D2 |
| truncado y STATUS | codex F13, opencode H-A | ola 0 D3, 06 |
| retry pierde validator | codex F12 | ola 0 D4 |
| git hooks / fsmonitor | agy 10 | ola 0 D5 |
| validadores concurrentes en un worktree | codex F04, agy 1 | 07 exclusión por change |
| reject sin barrera | codex F06 | 07 barrera |
| leases NULL tras migrar | codex F07 | 07 migración |
| migración no idempotente | codex F09 | reglas, `addColumn` |
| contrato humano de blocked | codex F10, opencode H-C | 06 |
| baseline sin persistir, salida de GATE_TAMPERED | codex F15 | 02 `base_sha`, `fab gate allow` |
| archivos nuevos y config del runner | agy 8, 9; codex F14 | 02 lista por defecto, altas cuentan |
| cambio solo en commit | opencode H-B | 02 compara HEAD |
| kill sin grupo de procesos | agy 14, codex F02 | 07 aborto real |
| manifest solo en merge; merge no recuperable | opencode H-E, codex F19, agy 12 | 04 |
| threatmon sin stderr ni lo truncado; fuente de medición vacía | agy 3, opencode H-G | 03 tras 04 |
| verificador sin copia desechable; gates FIFO; gates sin integración | agy 7, codex F20, opencode H-J | 01 |
| `agents verify` faltante | opencode H-K | candidato nuevo ola 2 |
| fake demasiado rápido para carreras | opencode H-I | reglas: fake lento + reloj |
| tests existentes que cambian | opencode 3.2 | §5 |
| `merge --force` y `reject` sin auditoría | opencode 3.4 | 09 |

## No aplicados
- Proteger por defecto **todos** los archivos de configuración "inmutablemente" (agy 9): se adoptó lista por defecto ampliable con salida auditada, no inmutable, para no bloquear changes que deban tocar `package.json`.
- Subir 05 a ola 1 (opencode H-Q): se mantiene en ola 4; las recetas de 01-03 no cambian prompts.
- Contención en tiempo real para agy (agy 4): fuera de alcance; declarado en 03 y §6.

## Señales M
Desvío de intención: no. Candidato incompleto: ola 0 sin receta por ser correcciones con test. Evidencia débil: cerrada para D1-D5 (verificadas leyendo `store.ts:226,481-498,634-644`, `worktrees.ts:5-6` y reproduciendo D3); D6-D8 aceptadas con evidencia de línea del revisor, no reproducidas por el elefante. Revisor perezoso: no (canary 3/3). Presupuesto: sin consumo registrado (deuda abierta del diseño). Incidente operativo: codex se autoactualizó 0.165 → 0.166 al saltar su aviso de actualización (tecla mal enviada por el elefante).
