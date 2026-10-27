# Posicionamiento: fábrica y agente de código

Contrato C, 2026-10-27. Rama `feat/landing-positioning`, creada desde
`origin/main` en `c8d4edd`. Solo cambian `site/**` y `docs/landing/**`.

## Decisión

**La fábrica de fab opera en la máquina, sobre un repositorio; hoy no opera
desde esta web.** Su estado no está necesariamente dentro del repo:
`src/cli.ts:29` resuelve `FABRICA_HOME` o `~/.fabrica`, y `src/cli.ts:72`
abre `fabrica.db`. `src/store.ts:95` define workstreams, signals, changes,
activities y events; `src/store.ts:199` abre SQLite. El repositorio conserva
el código y las ramas. `src/worktrees.ts:18` crea/reutiliza un worktree por
change bajo el directorio de estado, y `src/worktrees.ts:50` fusiona en la rama
actual y retira el worktree. No es una fábrica alojada en la landing ni todo
su estado es un archivo de configuración versionado en el repo.

El agente de código es un ejecutor distinto. `src/agent/exec.ts:21` expone el
runtime independiente `fab exec`; `src/agents.ts:107` adapta ese runtime como
worker `native`. `src/pool.ts:20` toma una actividad, obtiene su contexto y
worktree, lanza el agente y registra su resultado. La fábrica coordina el ciclo;
el agente ejecuta el trabajo. Una sesión independiente no implica pasar por
el ciclo de la fábrica.

Línea propia: **«La fábrica de software en tu terminal.»** Nombra la categoría
y la superficie real. La portada conduce a `#fabrica` y `#agente`; cada una
tiene su explicación y sus acciones. El explorador mantiene sus ocho módulos.
El final explica conexiones y rutas, y cierra con instalación y disponibilidad,
en vez de presentar «Gratis» como precio o un servicio futuro como actual.

## Afirmaciones verificadas en fab

| Tema | Evidencia | Consecuencia editorial |
| --- | --- | --- |
| Entrada y promoción | `src/cli.ts:170`, `src/cli.ts:181`; `src/connectors/intake.ts:16` | Entrada manual/Jira, seguida de promoción a change; no se anuncia triage automático con IA. |
| Aprobaciones humanas | `src/store.ts:325`, `src/store.ts:545`, `src/store.ts:591`; `src/cli.ts:156` | Revisión del change y de la especificación según configuración. No se promete aprobación universal. |
| Puerta de merge | `src/validators/publish.ts:29`; `src/cli.ts:242` | Un change debe estar implementado; validadores solicitados pendientes o FAIL bloquean. `--force` omite ese bloqueo, no las demás transiciones ni los conflictos de Git. |
| Ejecución | `src/pool.ts:20`, `src/agents.ts:21`, `src/agents.ts:43`, `src/agents.ts:60`, `src/agents.ts:107` | La landing anuncia `claude`, `codex`, `agy` y el nativo. Se retira la mención de droid del explorador y del diagrama de arquitectura, incluida su etiqueta accesible. Su adaptador sigue intacto en src. |
| Proveedores nativos | `src/agent/settings.ts:22`, `src/agent/settings.ts:110` | anthropic, openai, chatgpt mediante sesión de Codex y generic-chat-completion-api; customModels con baseUrl/apiKey según proveedor. Local describe estado/ejecución, no obliga a inferencia local. Compatibilidad de protocolo no equivale a smoke de un servicio. |
| Jev | `src/agent/router/config.ts:21`, `src/agent/router/jev.ts:15`, `src/agent/router/index.ts:24` | Clasificador remoto configurable y con clave. Si no está disponible, primer candidato elegible sin respaldos. |
| Selección auto | `src/agent/router/select.ts:28` | Menor relativeCost configurado entre viables. Sin viables, mayor puntuación; un único candidato no necesita clasificación. No se afirma ahorro medido. |
| Reintentos auto | `src/agent/providers/auto.ts:54`, `src/agent/providers/auto.ts:175`; `src/agent/providers/attempt-policy.ts:31`; `src/agent/provider.ts:155` | 429/5xx reintentables, Retry-After y rotación al agotar intentos; 400 de modelo permite rotación; 401/403 son terminales. No se repite un stream que ya emitió texto. |
| Omni | `src/agent/omni/runtime.ts:26`, `src/agent/omni/policy.ts:17`, `src/agent/omni/policy.ts:73`, `src/agent/omni/catalog.ts:1`; `docs/omni-provider.md` | Destinos del operador por modelo/cuenta/grupo de cuota. ToS avoid siempre excluido y desconocidos deshabilitados; catálogo de referencia sin sincronización legal en vivo. Perfiles declarados de pago con opt-in. |
| Costes y composición | `docs/spec-omni-provider.md:32`; `src/agent/omni/runtime.ts:32` | costTier es declaración operativa, no tarifa verificada. Sin tokens gratis ni garantías de gratuidad. Auto y omni no se combinan. |
| Aislamiento | `src/agent/exec.ts:32`; `src/sandbox/wrap.ts:23`, `src/sandbox/detect.ts:30`; `src/agents.ts` | Bubblewrap para herramientas nativas en Linux cuando esté disponible, required lo exige; macOS con permisos del usuario y CLIs externos con políticas propias. |

No se modificó código de producto ni se hicieron llamadas de inferencia real.
El MCP de Codebase Memory no tiene este worktree entre sus proyectos registrados;
se usó graft y lectura directa de los archivos citados. No se atribuye cobertura
exhaustiva al grafo.

## Referencias revisadas y límites

La revisión cubre las superficies indicadas por el contrato, no la implementación
completa de estos productos. Sus comportamientos no se convierten en capacidades
de fab. No se copiaron código, prompts, skills ni texto comercial; no se leyeron
bundles ni prompts capturados. Las marcas de referencia no se anuncian en la página.

### Factory: documentación pública clonada

Base local: `/home/orlando/Desktop/factory/doc/droid-re/docs-md/pages/software-factory/`.
Se revisaron completos `overview.md`, `triage.md`, `automations.md`,
`incident-response.md` y los cuatro documentos `wiki/overview.md`,
`wiki/generate.md`, `wiki/auto-refresh.md`, `wiki/web-viewer.md`.

- `overview.md:19` y `overview.md:39`: la aplicación concentra seguimiento y
  configuración del sistema. `triage.md:11`: la entrada se clasifica y enruta;
  recibir trabajo no es lo mismo que ejecutarlo.
- `automations.md:5` y `automations.md:168`: configuración persistente y sesión
  individual son conceptos distintos. Identidad, entorno y visibilidad también.
  `automations.md:299` distingue almacenamiento local, alojado y workflows GitHub.
- `incident-response.md:103`: alerta, automatización, sesión, investigación y
  devolución de estado se cuentan como pasos distintos. `automations.md:429`
  hace depender las aprobaciones del nivel de autonomía y riesgo.
- `wiki/generate.md:21`, `wiki/overview.md:23` y `wiki/web-viewer.md:52` separan
  generación local, publicación y consulta web. `wiki/auto-refresh.md:20` exige
  revisar el workflow antes de habilitar el refresco.

Se adopta la claridad de responsabilidades y ubicaciones. Fab no anuncia su
panel, automatizaciones persistentes, wiki alojada ni monitor como implementados.

### Warp: tres páginas públicas y el clon

Consultadas el 2026-10-27 mediante Agent Reach/Jina:
<https://www.warp.dev/factories>, <https://www.warp.dev/agent-cli> y
<https://www.warp.dev/terminal>. Se revisaron las secciones de producto,
configuración, flujo, control, modelos y límites de cada página.

Factories separa definición de fábrica, ejecución por agentes, infraestructura
y superficies de supervisión; su FAQ distingue ese producto de la terminal.
Agent CLI explica el ejecutor y la elección de modelos; Terminal se centra en
sesiones, interacción y revisión. La separación de páginas evita que una
superficie de trabajo se confunda con la orquestación completa.

En el clon `/home/orlando/Desktop/factory/warp`, `README.md:26` distingue el
entorno de terminal de los agentes; `README.md:45` presenta las fábricas como
infraestructura. `FAQ.md`, apartados «What's open source and what isn't» y
«What lives in this repo and what doesn't», separa cliente de servidor y
orquestación alojada. Se consultó su grafo únicamente como referencia estructural.
AGPL-3 para el cliente: solo referencia de diseño; no se incorporó código ni copy.
Fab no hereda de esa referencia factories-as-code, agentes cloud, métricas,
infraestructura gestionada ni garantías de seguridad.

### opencode: registro del posicionamiento

Clon `/home/orlando/Desktop/factory/ext/opencode`, MIT. `README.md:10` y
`packages/console/app/src/i18n/en.ts:65` nombran directamente la categoría;
`en.ts:73` explica qué hace el agente y en qué superficies se usa. Se toma el
registro concreto y breve, no su frase, promesa de modelos incluidos ni cifras.
No se atribuye una licencia open source a fab por analogía.

## Entrada para el Contrato D: figuras pendientes

Después de fusionar C. Mantener la marca, las escenas geométricas del explorador,
modos claro/oscuro, foco visible y movimiento reducido. No ejecutar comandos ni
consultar proveedores desde la web. No animar los datos como actividad real.

| Sección | Figura que necesita | Qué debe quedar claro |
| --- | --- | --- |
| Portada `#inicio` y vínculo `#fabrica` → `#agente` | Relación entre ciclo de la fábrica y ejecución de una actividad por el runtime | SQLite conserva estado; worktree contiene cambios; el agente ejecuta; la decisión de merge pertenece al flujo. Conservar la terminal capturada y su aviso de fixtures. |
| Sandbox `#sandbox` | Límites de herramientas nativas Linux frente a macOS y CLIs externos | La frontera bubblewrap no rodea todos los procesos ni promete aislamiento absoluto. |
| Modelos `#modelos`, `#router-auto`, `#router-omni` | Conexión nativa a endpoints y dos rutas alternativas | Auto/Jev clasifica modelos por aptitud/coste relativo declarado; omni gestiona destinos por cuenta/cuota/ToS. No dibujar una cascada auto→omni ni etiquetas de saldo/regalos. |
| Cierre `#planes` | Operación actual frente a propuesta gestionada | CLI/TUI local disponible y web/runners en estudio. Sin precio cero, tabla de tarifas inventada, captación ni apariencia de servicio disponible. |

Los ocho módulos existentes ya tienen SVG. No se solicita redibujarlos. Este
contrato solo corrige la lista de adaptadores de sus etiquetas públicas.
