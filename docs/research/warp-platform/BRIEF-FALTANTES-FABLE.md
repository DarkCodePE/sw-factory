# Brief: qué falta en fab para replicar Warp Factories (Fable 5.2)

Eres un analista sin contexto previo. El dueño quiere **replicar en fab todas las capacidades** de Warp Factories, con diseño propio. Tu trabajo es decir exactamente qué falta y convertirlo en tareas.

## Lee primero
En `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/`:
- `recorrido-codex.md`: el recorrido completo de Codex. Es la fuente principal.
- `catalogo-fable.md`: el catálogo anterior, con el cruce y la sección «qué conviene no copiar» (§5).
- `BRIEF-WEB-F2-CODEX.md` y `BRIEF-WEB-F3-CODEX.md`: lo que ya está en curso. Si existen `impl-f2-codex.md` e `impl-f3-codex.md`, léelos también.

Además:
- El código de fab, en el worktree `/home/orlando/Desktop/factory/sw-factory-fabweb` (rama `feat/fab-web`, PR #80, con F0/F1).
- `task.json` del checkout principal `/home/orlando/Desktop/factory/sw-factory`: las tareas que ya existen. No las dupliques; enlázalas.

## Qué hacer
1. **Por cada módulo de Warp** que describe `recorrido-codex.md`:
   - Su objetivo, en una línea.
   - Su estado en fab:
     - **hecho**, con `ruta:línea`;
     - **en curso**: F2, F3 o una tarea existente;
     - **parcial**: dato que existe sin superficie;
     - **falta**;
     - **no aplica**.

   Verifica el estado en el código con graft o lectura directa. No lo copies del catálogo.
2. **Lo que falta, en tareas** con el formato de `task.json`. Mira su esquema y copia la forma de las tareas existentes: id nuevo libre, título, objetivo, criterios de aceptación medibles, dependencias, estimación y riesgo.
   - Agrúpalas por fases después de F3, como F4, F5…, con un orden que respete las dependencias.
3. **Seguridad y reglas de fab.** Para cada capacidad que choque con una regla de fab o con la §5 del catálogo (puertas en el prompt, admisión por texto, webhooks que lanzan turnos, secretos en el servidor, automejora que se aplica sola…), propón **cómo replicarla respetando la regla**: por ejemplo, el webhook crea una señal que pasa por el gate.
   - Si no hay forma segura, márcala `[DECIDIR]` con las opciones. El dueño quiere replicar todo, así que «no se hace» solo vale con una razón concreta.
4. **Revisa a Codex.** Si `recorrido-codex.md` tiene huecos, contradicciones o inferencias débiles, lístalos.

## Reglas
- **Solo lectura:** no edites `task.json` ni el código. Las tareas van en tu informe y el orquestador las añadirá.
- **No abras Warp ni el navegador:** trabaja con los informes y el código.
- **No abras `capturas/` ni `capturas-codex/`:** tienen datos personales.
- Sin subagentes, sin commits, sin escribir en GitHub.

## Salida
`/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/faltantes-fable.md` con:
1. **Tabla de módulos:** módulo, objetivo, estado en fab y evidencia.
2. **Resumen:** cuántos módulos hay en cada estado.
3. **Tareas nuevas:** un bloque JSON válido, listo para pegar en `task.json`, más una tabla legible con id, título, fase, dependencias, estimación y riesgo.
4. **Replicar sin romper reglas:** propuesta por cada capacidad conflictiva.
5. **`[DECIDIR]`**, con las opciones y tu recomendación.
6. **Huecos del recorrido de Codex.**

Última línea, exactamente: `<!-- FIN -->`.
