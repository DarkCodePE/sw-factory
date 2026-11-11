# Brief: doble check arquitectónico del diseño 06 (Fable 5.2, goldfish)

Eres un revisor de arquitectura sin contexto previo. Vas a revisar el diseño de cómo la fábrica de software `fab` incorpora el tramo del «superagent»: escuchar un canal, decidir qué petición se convierte en trabajo y mantener un worker al que se le puede corregir el rumbo. Antes de la fase 2, que añadirá el contrato vivo, el estado `awaiting` y el Outbox, se quiere un segundo juicio con el código delante.

**Solo lectura.** No edites código, no hagas commit, no escribas en GitHub y no lances subagentes. Lo único que escribes es tu informe.

## Material
- **Diseño a revisar:** `/home/orlando/Desktop/factory/sw-factory/techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md`, versión v0.4.
- **Código de la fab:** `/home/orlando/Desktop/factory/sw-factory-docsint`, rama de `origin/release/0.1.0-rc.12`, que ya incluye las fases 0 y 1. Partes que importan:
  - `src/store.ts`: estados de change y activity, `claimActivity`, `requeueOrphans`, `blockActivity`, `retryChange`;
  - `src/pool.ts`: workers, lease, heartbeat y `processActivity`;
  - `src/agents.ts`: el `AgentAdapter` de un disparo;
  - `src/worktrees.ts`;
  - `src/admission/`: la fase 1, en modo observe: cola `adm_effects`, residente con lock, poller de GitHub, gate;
  - `src/agent/rpc.ts` y `src/sdk/`: la sesión viva que existe pero el pool no usa;
  - `src/connectors/`.
- **Espigas del contrato vivo:**
  - `/home/orlando/Desktop/factory/sw-factory-live-claude/src/live/{contract,claude}.ts`;
  - `/home/orlando/Desktop/factory/sw-factory-live-native/src/live/{contract,native}.ts`;
  - sus informes, en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/live/`.
- **Repos de referencia:**
  - `/home/orlando/Desktop/factory/dsh-superagent-prototype`: Engine, Trigger, Thread, Eval, Ticket, Assignment, `src/app/effects.ts`, `resume()`;
  - `/home/orlando/Desktop/factory/ext/copilot-superagent`: `vscode/src/agent-backend.ts` (AgentBackend), `vscode/src/runtime.ts` (puerto Executor), `vscode/src/worktree.ts`, orchestration;
  - `/home/orlando/Desktop/factory/ext/esf`: `Harness`, `internal/factory/workflow.go`, turn service;
  - `/home/orlando/Desktop/ia-master/dsh-herdr`: el observador;
  - `/home/orlando/Desktop/ia-master/deepseek-harness`.
- **Contexto de decisiones**, que debes leer **después** de formar tu opinión:
  - `docs/research/superagent-vs-fab/review/SINTESIS-EGM.md`;
  - `review2/SINTESIS-R2.md`;
  - `task.json`.

## Rol EGM
Usa `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/design_critic.md`, junto con `zoom_out.md` y `codebase_details.md`.

## Preguntas
1. **Threads.** ¿Cómo agrupa cada repo de referencia los eventos de una misma conversación? ¿Qué identidad usa, cómo deduplica y cómo entra una respuesta humana en el hilo correcto? Compáralo con `adm_threads`/`adm_triggers` de la fab. ¿Aguanta el modelo de la fab cuando haya respuesta humana y varios canales, o habrá que rehacerlo?
2. **Sesiones.** El diseño dice que «vivo» significa reanudable por id, no un proceso esperando (§5.1).
   - ¿Cómo lo hacen el superagent (`resume()`), copilot (AgentBackend) y ESF (turn service con `execution_id`)?
   - ¿Dónde vive el `sessionId` en la fab, y sobrevive a la caída del pool, a un `requeueOrphans` o al cambio de worker?
   - ¿Qué pasa si el harness pierde la sesión, por ejemplo si caduca en claude o si cambia el modelo?
   - ¿El diseño trata «sesión irrecuperable»?
3. **Ejecutores.** Revisa la decisión D2: dos niveles, efectos durables del dominio más un contrato vivo por harness `{run, assess, steer?, handoff?, abort, dispose}`.
   - ¿Es la frontera correcta frente al `Executor {start, deliver, stop}` de copilot y al `Harness` de ESF?
   - ¿Quién reintenta y quién no, según la regla de ESF de no reintentar al agente?
   - ¿Cómo se combina con el lease de 90 s del pool, que mata un turno largo?
   - ¿Cuadra con las espigas `live/contract.ts`?
4. **Tickets y workers.** En el superagent hay Ticket y Assignment; en la fab hay change, activity, lease y slot.
   - ¿Cómo se corresponden? ¿Qué es en la fab un «worker asignado a un ticket» con conversación?
   - ¿Cuánto vive un slot? Una activity `awaiting` no debe ocupar slot: ¿cómo se reanuda, quién la reencola y con qué fencing (`workerId` por claim de la fase 0, `attempt_id` de `adm_effects`)?
   - ¿Qué pasa con las cuotas y la concurrencia cuando hay varias conversaciones abiertas?
5. **Threat model.** El texto del issue o de la respuesta humana es no confiable (ADR-0007).
   - Revisa el camino completo: canal → Trigger → gate → router → signal → prompt → agente → respuesta → Outbox.
   - ¿Dónde puede escalar privilegios el texto?
   - ¿Es suficiente la verificación de la etiqueta de la fase 1, que exige rol triage o superior en quien la pone?
   - ¿Qué falta para la respuesta humana en la fase 2? ¿Quién está autorizado a responder en un hilo, y se verifica?
   - En el Outbox, ¿puede el agente hacer que la fab publique contenido arbitrario en el canal?
6. **Coherencia del documento.** ¿Hay contradicciones internas o afirmaciones que el código ya desmiente? Las fases 0 y 1 ya están implementadas y el documento sigue citando `ce84fc4` y la v0.4. ¿Qué secciones habría que actualizar?
7. **Lo que falta para la fase 2.** Lista concreta y ordenada de decisiones y piezas, con lo mínimo para cumplir la condición de salida de §7: costura completa con fallos inyectados en cada frontera.

## Método
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos. En los repos de referencia sin índice graft, usa lecturas acotadas.
- Cita cada afirmación como `ruta:línea`. Distingue lo **verificado**, leído en código, de lo **inferido**.
- Si el código desmiente al diseño, dilo con la cita.

## Salida
Escribe en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/fable.md`:
- **Veredicto:** ¿el diseño está listo para empezar la fase 2? Elige entre «sí», «sí con cambios» o «no».
- **Una sección por pregunta (1-7)**, con una tabla comparativa fab / superagent / copilot / ESF donde aplique.
- **Tabla de hallazgos:** id, severidad (alta, media o baja), `ruta:línea` o sección del documento, problema, escenario que falla y propuesta.
- **Contraste con `SINTESIS-R2.md`,** escrito después de tus hallazgos: qué confirmas, qué contradices y qué es nuevo.
- **Lo que no revisaste.**

Última línea, exactamente: `<!-- FIN -->`.
