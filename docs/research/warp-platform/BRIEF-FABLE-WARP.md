# Brief: catálogo de la plataforma web de Warp Factories frente a fab (Fable 5.2)

Eres un analista de producto y arquitectura. No tienes contexto previo.

**Objetivo del usuario:** construir para `fab` (sw-factory, su fábrica de software con agentes) una plataforma web con las capacidades de Warp Factories. Tú no construyes nada: haces el catálogo anotado de la web de Warp y lo cruzas con los módulos que fab ya tiene, para saber qué se cubre ya, qué falta y en qué orden construirlo.

## 1. Cómo navegar (solo lectura, con la cuenta del usuario)

Usa **agent-browser** sobre la sesión ya abierta e iniciada por el usuario, siempre con estos flags:
```
agent-browser --session warp --restore --headed --args "--no-sandbox" <comando>
```
Comandos útiles: `snapshot -i` (árbol con refs), `get url`, `get text`, `screenshot <ruta>`, `click @ref`, `open <url>`, `scroll`. Si no los conoces, ejecuta `agent-browser --help` o lee `/home/orlando/Desktop/factory/ext/agent-browser/skills/`.

- Empieza en `https://platform.warp.dev/runs?factory_uid=<factory>&hideBackgroundRuns=true&createdBy=<usuario>`.
- Recorre **todas** las secciones del menú y de los ajustes: runs y detalle de un run, factories, agentes (foreman, triage, spec, code, review), integraciones, repos, ajustes, facturación, equipo y onboarding. Abre pestañas, desplegables, modales y vistas de detalle **solo para leerlos**, y ciérralos con Escape o Cancel.
- **Prohibido, sin excepciones:**
  - pulsar Connect, Install, Create, New, Run, Start, Save, Delete, Invite, Upgrade, Submit, Next o Finish en el onboarding, o cualquier botón que cambie el estado;
  - escribir en formularios, cambiar toggles, lanzar runs o aprobar specs o PRs.

  Si dudas de si un clic modifica algo, no lo hagas y anótalo como «no explorado».
- Si la sesión no tiene login o caduca, para y escríbelo en el informe. No introduzcas credenciales.
- No copies a tu informe datos privados del usuario (emails, tokens, nombres de repos privados, contenido de issues o código). Describe la estructura, no el contenido.
- **Capturas:** guárdalas en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/capturas/NN-nombre.png`, una por pantalla relevante.
- Las propias capturas del usuario de la configuración de agentes y del onboarding de code hosts están en `/tmp/claude-1000/-home-orlando-Desktop-ia-master/a82ff1be-88c1-4b9c-944e-03eeba3f3ea6/images/13.png` y `14.png`.

## 2. Qué tiene fab hoy (léelo antes de cruzar)

- **Código en la release:** worktree `/home/orlando/Desktop/factory/sw-factory-t11`, solo lectura.
  - `src/`: `store`, `pool`, `worktrees`, `agents`, `admission/` (residente, gate, Mandate, outbox), `live/` (turno vivo, `report`), `sandbox/`, `connectors/` (Jira, PR), `validators/`, `gates`, `improve`, `profile`, `tui`, `chat`, `sdk`.
  - Su `AGENTS.md`.
- **Documentación por capas:** `/home/orlando/Desktop/factory/sw-factory-t11/techdocs/docs/factory/` (00 a 13) y `/home/orlando/Desktop/factory/sw-factory-t11/techdocs/docs/investigacion/`.
- **Tareas y decisiones:** `/home/orlando/Desktop/factory/sw-factory-t11/docs/research/superagent-vs-fab/task.json`.
- **Referencia previa sobre Warp:** la skill `fab-referencias` y el código abierto de Warp en `/home/orlando/Desktop/factory/warp`. Úsalo solo si aclara algo de la web.

## 3. Informe

Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/catalogo-fable.md` con estas partes:

1. **Mapa del sitio:** árbol de secciones y URLs (sin ids privados), con una línea por pantalla y su captura.
2. **Catálogo de capacidades:** una tabla con id, sección, capacidad, qué hace el usuario, qué entidades muestra (run, factory, agente, spec, PR, integración…), sus estados visibles y la captura.
3. **Modelo inferido de Warp:** entidades, relaciones y ciclo de vida de un run (foreman → triage → spec → code → review → PR), y los puntos donde interviene el humano.
4. **Cruce con fab:** para cada capacidad, si está **cubierta**, **parcial** o **falta**, con el módulo o archivo de fab que la cubre (`ruta:línea` cuando aplique) o la tarea de `task.json` relacionada. Una tabla más un resumen en porcentaje.
5. **Qué conviene no copiar:** lo que choca con las invariantes de fab, como el texto como dato, el rol triage para autorizar, el confinamiento o D1 (solo con etiqueta). Explica por qué.
6. **Plan por fases:** el mínimo para tener una plataforma web propia de fab, desde una vista de solo lectura de runs y changes sobre el Store hasta lo demás. Indica qué API o capa de fab falta en cada fase, y la estimación y el riesgo de cada una. Diseño original de fab: inspírate en las capacidades, no copies la marca ni el aspecto visual de Warp.
7. **[DECIDIR]:** preguntas concretas para el dueño, con opción recomendada.
8. **Lo no explorado** y por qué.

## Reglas
- Solo lectura en Warp y en fab. Solo escribes el informe y las capturas.
- No lances subagentes. No escribas en GitHub ni en ningún servicio.
- Cuando termines, cierra la sesión del navegador con `agent-browser --session warp close`, y solo entonces.

Última línea del informe, exactamente: `<!-- FIN -->`.
