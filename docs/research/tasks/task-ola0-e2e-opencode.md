# Tarea — opencode: verificación real de la ola 0 (D5, H2) y carreras multiproceso

Repo: /home/orlando/Desktop/factory/sw-factory-ola0-e2e (rama `fab/research-ola0-e2e`, base `main@7783845`, ola 0 integrada).
Contexto: /home/orlando/Desktop/factory/sw-factory/docs/research/runs/2026-10-30-ola0/resultado.md y plan-esf-candidatos.md §1 (D5, D6, D7, H2).

**No modifiques `src/`.** Solo puedes crear archivos bajo `scripts/e2e/` en tu worktree. Trabaja con copias en /tmp; nunca toques otros worktrees.

## Qué probar con `fab` real (CLI `bun src/cli.ts`, agente `fake`, copia de `examples/toy-calc` en /tmp)
1. **D5**: en el repo de la copia, configura un hook malicioso y un fsmonitor (`git config core.hooksPath` a un dir con `post-checkout`/`pre-commit` que escriba un marcador en /tmp, y `core.fsmonitor` a un script que también escriba un marcador). Corre un ciclo `fab` completo (señal → implementación → validadores → merge). Resultado esperado: ningún marcador creado por git dentro de los worktrees de fab. Repite contra la rama `29d4dd3` (main previo a ola 0, usa `git worktree add` en /tmp) para mostrar que allí sí se ejecutaban.
2. **H2**: haz que un validador deje cambios sin commitear en el worktree (con el fake, p. ej. variables de entorno del adaptador fake o un script; lee `src/agents.ts` para ver cómo) y comprueba que la activity falla con `<validador> dejó cambios en el worktree`. Hazlo para un validador distinto de QA.
3. **Carreras multiproceso (línea base para la ola 1, ficha 07)**: lanza dos `fab run <ws>` en paralelo sobre el mismo store con un fake lento, con varios changes. Mide: activities reclamadas dos veces, dos escritores en el mismo worktree, escrituras después de `fab reject`, y qué pasa al `kill -9` de un pool (¿se reencola?, ¿cuánto tarda?). Repite 10 veces. Hoy se esperan fallos (D6/D7): el objetivo es **medirlos de forma reproducible**, no arreglarlos.

## Entrega
- Scripts reproducibles en `scripts/e2e/` (bash o bun), commit en tu rama en español, sin `Co-Authored-By`. Sin merge ni push.
- Reporte en `/home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola0-e2e-opencode.md`: por cada prueba, comandos, salida relevante, resultado (pasa/falla) y las cifras de carreras (n=10). Si algo no se puede probar, dilo y explica por qué.
