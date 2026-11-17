# Brief: T13, fase 3 (router). Análisis previo a implementar (Fable 5.2)

Eres el analista y arquitecto. **No implementas.** Tu informe será la base del brief que recibirá Codex, el implementador. Después lo verificará otro revisor.

- **Worktree, solo lectura:** `/home/orlando/Desktop/factory/sw-factory-t13`, rama `feat/t13-router` sobre `origin/release/0.1.0-rc.12`. Ya incluye la fase 2 (T12, PR #67).

## Fuentes
- `techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md`. Lo esencial está en:
  - §5, con la fase 3: «Router, Mandate y Subscriptions; solo con un canal real y evidencia de necesidad»;
  - I2: `assess` es el router;
  - D5 e I5: el router trata el texto como dato y no puede ampliar el `scope` que fija el gate;
  - la fila de inyección (ADR-0007).
- `07-ronda3-hallazgos-fase2.md` y `04/05-dsh-*.md` en la misma carpeta. Allí está el modelo de superagent (router, mandate, subscriptions).
- El código de admisión, ya integrado:
  - `src/admission/` (gate, triage, resident, links y answers);
  - `src/live/` (contract y turn);
  - `src/pool.ts`.
  - Úsalo con graft (`graft ask`, `skeleton`, `callers`) o por tramos con `sed -n`, sin grep masivos.
- `docs/research/superagent-vs-fab/task.json` en `/home/orlando/Desktop/factory/sw-factory`:
  - T13;
  - T11 (observe con datos reales, todavía pendiente);
  - T39 y T40.
- El repo de referencia superagent, si está en `/home/orlando/Desktop/ia-master/dsh-superagent-prototype`. Indexado con graft.

## Qué decidir y justificar
1. **¿Toca ahora?** El diseño condiciona la fase 3 a un canal real y a evidencia de necesidad.
   - ¿Hay hoy un canal real (GitHub issues y comentarios en modo `auto`) y un problema que el gate y el triage actuales no resuelven?
   - Si no toca, di qué mínimo sí aporta valor ya y qué evidencia hay que reunir antes (T11).
2. **Alcance mínimo de la fase 3.** Qué entra de Router (`assess`), Mandate y Subscriptions, y qué se aplaza. Para cada pieza:
   - el problema concreto que resuelve en fab;
   - por qué el gate y el triage actuales no bastan.
3. **Diseño.** Esto es lo que necesita el implementador:
   - **Interfaz:** tipos, dónde vive cada pieza (capa y archivo), y cómo se conecta con el gate, el residente, `ThreadLinks` y el pool.
   - **Datos:** tablas `adm_*` nuevas o cambiadas. No se tocan las tablas de la fab.
   - **Invariantes de seguridad:**
     - texto como dato;
     - el `scope` no se amplía nunca;
     - no confiable aunque lo produzca un LLM;
     - rol triage o superior para autorizar;
     - comentarios propios descartados.
   - **Fronteras de fallo:** dónde caer y reiniciar, al estilo del 07 §6 y de `CrashPoint`.
   - **Coste:** qué modelo hace de router y cuándo se llama. ¿Puede ser determinista al principio?
4. **Plan de implementación para Codex:** tareas ordenadas y pequeñas. Cada una con:
   - archivos;
   - tests que deben fallar antes del cambio;
   - criterio de hecho.

   Señala lo que no debe tocar.
5. **Riesgos y preguntas abiertas** que el humano debe decidir antes de implementar. Márcalas claramente como **[DECIDIR]**.

## Roles EGM
Aplica los criterios de `design_critic.md`, `zoom_out.md` e `implementation_readiness.md`, que están en `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/`.

## Reglas
- **Solo lectura.** No edites código, no hagas commit, no escribas en GitHub y no lances subagentes.
- Lo único que escribes es tu informe.
- Cita como `ruta:línea`. Distingue lo **verificado**, leído o ejecutado, de lo **inferido**.

## Salida
Escríbela en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t13/analisis-fable.md`:
- **Veredicto:** implementar ya, implementar un mínimo, o esperar evidencia.
- Las secciones 1 a 5 de arriba.
- **Lo que no revisaste.**

Última línea, exactamente: `<!-- FIN -->`.
