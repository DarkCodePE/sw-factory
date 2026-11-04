# meta.md — run 2026-10-30-B-esf-01 (cierre)

Verificadores: codex (goldfish-codex), agy (goldfish-agy), opencode
(glm-5.3-flash-free), paneles herdr, sin acceso a conversación ni memoria.
Informes: scratchpad de la sesión `reviews/esf-{codex,agy,opencode}.md`.

## Canary
Plantado: "ESF abre el PR en GitHub automáticamente (`provider.go:357-363`)".
Detectado por los tres (codex E01, agy §1.1, opencode E22). Retirado en v0.2.

## Señales (tras el parche)
| Señal | Resultado | Evidencia / acción |
| --- | --- | --- |
| Desvío de intención | no | La canónica pedía pull, ejecutar y verificar graft; los tres pasos están en `canonical.md` (sha antes/después, build 2560 nodos, check en sincronía). |
| Candidato incompleto | parcial → cerrado para `propuesto` | Diez fichas con variable intervenida, guardianas, ratio, licencia; `candidato.sha` queda vacío por diseño hasta `experimento_autorizado`. |
| Evidencia débil | cerrado | 13 citas muestreadas por el elefante + 24/12/13 por los goldfish; corregidas E02 (README 57-60), E03 (exit 0 sin timeout), E11 (sonda en `egress_probe.go`), E20 (PromptArgv existe), F05 (pool no solo porcelain), F22 (grep). |
| Contradicción decisiva | cerrado | Era el canary. |
| Sesgo de confirmación | alerta | Añadida evidencia adversa en 01 y 03; el resto sigue sin fuente en contra explícita. |
| Goodhart / regresión | cerrado en recetas | Métricas sintéticas sustituidas por corpus real (03), varianza de resultado (05), control positivo (08); guardianas comunes declaradas. |
| Perfil de despliegue | cerrado | Temporal, Cube, Harness2 completo y consola TLS marcados incompatibles; el resto se reimplementa. |
| Licencia / ToS | cerrado | MIT con hash; harness2 Apache-2.0 sin runtime; `tos_risk: ninguno` en todas las fichas. |
| Clean room | no aplica | MIT; nadie implementó todavía. |
| Presupuesto | no verificable | 3 h / 10 USD declarados; sin consumo registrado por paso. Deuda: registrar recibos de subagentes. |
| Alucinación de código | cerrado | Ver evidencia débil. |
| Contexto contaminado | no verificable documentalmente | Sin manifiesto de rutas accesibles por revisor. Deuda del diseño §8. |
| Revisor perezoso | no | Los tres encontraron el canary y aportaron puntos ciegos nuevos (inferencebudget, turnexec, notify, ADR 0006, live.go). |
| Receta no reproducible | no aplica | No hay medición; todas en `propuesto`. |
| Staleness | cerrado | `last_sha` d901657, `last_analyzed` 2026-10-30. |
| Loop sin fin | no | Una iteración parche→revisión. |

## Hallazgos de goldfish no aplicados (diferidos)
- Reasignar `BLOCKED` solo a C2 (agy 2.3): se marcó cruzado C2/C4b.
- Capa "meta-harness" para cualificación y rollout (codex P05): diferido como en el diseño §11.
- Repetir la revisión tras el parche (opencode): diferido; el parche solo retira y precisa, no añade capacidades nuevas salvo el candidato 10, que cita líneas verificadas por el elefante.

## Deudas para el diseño
- §6: el pull y `graft build` se ejecutaron en el host; hace falta el procedimiento bwrap real.
- §8: manifiesto de rutas accesibles por revisor.
- §9 presupuesto: recibos por paso de subagentes.
