# Loops de investigación comparativa para `fab`

Estado: v0.2 (2026-10-30). Elefante: Claude. Goldfish: codex, agy, opencode
(glm-5.3-flash-free). Sus informes completos quedaron en el scratchpad de la
sesión; §9 resume qué se aceptó y qué no.

Objetivo: comparar `fab` contra otras fábricas de software y absorber sus
mejoras de forma medible. Tres loops:

| Loop | Pregunta que responde | Entrada | Salida |
| --- | --- | --- | --- |
| **A. Investigación profunda** | ¿Qué ideas, papers y repos resuelven esta limitación de fab? | Cabecera común (§2) con una limitación contra una capa | Candidatos con evidencia citada y receta de medición |
| **B. Análisis de repo** | ¿Qué aporta este repo concreto a cada capa de fab? | Cabecera común (§2) con URL o ruta de un repo | Ficha del repo, matriz repo→capas, candidatos con receta |
| **M. Meta-loop** | ¿La investigación sigue la intención y las reglas? | Artefactos de A o B | Señales de desvío, bloqueos, decisión de parar/continuar |

Metodología base: EGM (elefante diseña con contexto, goldfish revisan sin él,
humano aprueba), pipeline de hyperresearch (descomponer → barrido ancho →
loci → críticos → parche, nunca regenerar) y Agent-Reach / graft como
acceso a fuentes. Cada loop escribe en archivos, no en memoria de agente;
cada claim decisivo lleva receipt (commit o hash, archivo:línea, URL, fecha).

---

## 1. Capas de fab (taxonomía de clasificación)

Toda mejora, idea o repo se clasifica con **una capa principal** y **capas
afectadas**. Niveles por capa: `fuerte | parcial | ausente-verificado |
no-evaluado | no-aplica`. Ámbito: `producto` (capacidad de fab) o
`investigacion` (herramienta de este proceso, no de fab).

| Capa | Qué cubre en fab | Código | Métrica primaria |
| --- | --- | --- | --- |
| **C0 Interfaz y experiencia** | CLI, TUI, `fab exec`, mensajes de error, onboarding, docs | `src/cli.ts`, `src/tui.ts`, `src/chat/`, `README.md` | Acciones, errores y retrocesos por tarea fija en cada superficie (TUI / exec / fábrica); tiempo activo humano |
| **C1 Conectores e integración** | Señales, triage, Jira/GitHub en ambos sentidos: import, PR, publicación de validación, comentarios, reconciliación | `src/connectors/`, `src/store.ts` (signals) | Precisión/recall de triage sobre set etiquetado; duplicados y estados inconsistentes con el sistema externo |
| **C2 Orquestación** | Workstreams, activities, pool, leases, reintentos, recuperación, planificación de tareas de desarrollo (crons de SDLC) | `src/pool.ts`, `src/store.ts`, `src/worktrees.ts` | Entregas correctas por hora (no activities); recuperación tras kill; reintentos por change |
| **C3 Control humano** | Gate 1/2/3 como decisión del operador, inbox, review, `--force` | `src/cli.ts` (review/merge) | Tiempo activo humano por gate; reversiones post-merge; `--force` (solo como alarma, nunca como mejora) |
| **C4a Modelos y adaptadores** | Proveedores, router, omni, cuotas, adaptadores claude/codex/agy/droid, streaming | `src/providers/`, `src/router/`, `src/omni/` | Coste total por entrega aceptada; éxito en ≥2 benchmarks |
| **C4b Arquitectura cognitiva** | Herramientas, misiones, journal, hooks, prompts | `src/agent/` | Éxito en ≥2 benchmarks; llamadas a herramienta por entrega; defectos escapados |
| **C5 Aislamiento y seguridad** | worktrees, bwrap, política de red/archivos, MCP OAuth, yolo | `src/sandbox/`, `src/agent/*-policy.ts`, `src/agent/mcp-*.ts` | Escapes exitosos = 0 sobre N casos ejecutados, por plataforma y modo (Linux/bwrap, macOS best-effort); overhead |
| **C6 Validación y evidencia** | Validadores, `ValidationSummary`, merge gate programático, mission-evidence | `src/validators/`, `src/agent/mission-evidence.ts` | Sensibilidad (fallos plantados detectados) y precisión; bugs que pasaron |
| **C7 Persistencia, memoria y contexto** | SQLite, journal, search, índice/contexto de código, wiki futura | `src/store.ts`, `src/search/`, `src/agent/journal.ts` | Recuperación sin pérdida de estado; migraciones; staleness de índice |
| **C8 Operación y distribución** | Daemon, monitor, incidentes, update, release, CI, telemetría local | `src/update/`, `scripts/`, `.github/` | MTTR; éxito de `fab update`; incidentes por semana |
| **C9 Extensibilidad y protocolos** | SDK, JSON-RPC, MCP en proceso, hooks de terceros, compatibilidad de clientes | `src/sdk/`, `src/agent/rpc.ts` | Pruebas de compatibilidad de clientes; cambios rompientes por release |

Reglas de corte: lo que decide una **persona** va en C3; lo que decide
**código** va en C6. Planificar trabajo de desarrollo es C2; vida del binario y
salud del host es C8. Transversal: **licencia y ToS** (§7).

---

## 2. Cabecera común de toda ejecución (A y B)

`docs/research/runs/<run_id>/canonical.md`, inmutable tras crearse:

```yaml
run_id: 2026-10-30-C4a-router-01
loop: A | B
pregunta_canonica: "<texto exacto del usuario, sin reformular>"
capa_principal: C4a
limitacion_actual: {metrica: ..., valor: ..., receipt: ..., fab_sha: <sha>}
fuera_de_alcance: [...]
presupuesto: {fuentes_max: 40, horas_max: 2, usd_max: 15, concurrencia_max: 4, reserva_cierre_pct: 25}
```

`usd_max` y `horas_max` son numéricos obligatorios; M bloquea sin ellos. La
reserva de cierre garantiza síntesis y revisión aunque el barrido agote el
resto. Al agotar presupuesto se cancela el trabajo pendiente y se entrega
`estado: incompleto`.

Antes de empezar, verificar que la limitación **sigue existiendo** en el
`fab_sha` indicado (puede haberse resuelto o bastar una configuración).

---

## 3. Receta de medición (común a todo candidato)

Un candidato sin receta completa está incompleto y M lo bloquea.

```yaml
id: C4a-router-bandit-01
capa_principal: C4a
capas_afectadas: [C4b, C6, C3]
ambito: producto
hipotesis: "Enrutar con bandit reduce coste por entrega aceptada ≥20% sin bajar éxito"
variable_intervenida: "política de selección de modelo"   # lo que SÍ cambia
controles_fijos: ["conjunto de tareas", "catálogo de modelos versionado", "fab_sha base", "prompts"]
metricas:
  primaria: coste_usd_por_entrega_aceptada
  guardianas: [exito_benchmark, hallazgos_validadores, escapes_c5, tasa_force]   # no pueden empeorar
baseline:
  fab_sha: <sha>
  entorno: {bun: "1.x", os: "linux", modelos: {claude: "<id+fecha>", codex: "<id+fecha>"}}
  comando: <comando verificado con una corrida de humo en ese sha>
candidato:
  sha: <sha del commit del candidato en su worktree>   # nunca solo el nombre del worktree
  entorno: <idéntico salvo variable_intervenida>
benchmarks: [examples/toy-calc, <una tarea real del historial de fab>]   # mínimo 2 para C4
diseño: {n_runs: 10, pareado: true, orden_alternado: true, contar_todos_los_intentos: true}
umbral: "ratio candidato/baseline ≤ 0.80 en mediana; guardianas no inferiores (margen declarado)"
confusores: ["modelo upstream cambió bajo el mismo nombre", "caché de prompts"]
licencia_tos: {fuente: ..., riesgo_tos: ninguno|bajo|alto}
receipt: docs/research/runs/<run_id>/bench.jsonl   # una fila por intento con exit code y coste
estado: propuesto | experimento_autorizado | medido | integracion_autorizada | integrado | rechazado | inconcluso
```

Reglas:
- **Identidad**: baseline y candidato se identifican por sha; el entorno se
  guarda como manifiesto. "Mismo modelo" aplica a todo lo que no sea la
  variable intervenida; en experimentos de router el modelo elegido es
  resultado y se registra por intento.
- **Estadística**: n_runs ≥ 10 pareadas con orden alternado; se cuentan todos
  los intentos, incluidos abortos; si los IQR se solapan el resultado es
  `inconcluso`, no "mejora".
- **Guardianas**: una mejora que empeora una métrica guardiana se rechaza
  aunque cumpla su umbral (anti-Goodhart, anti-regresión entre capas).
- **Experiencia (C0)**: dos instrumentos separados y nunca mezclados:
  (1) recorrido automático por un agente sin contexto siguiendo solo la doc,
  que mide ejecutabilidad de la doc y acciones/errores por tarea; (2) prueba
  con personas: tareas fijas por superficie (TUI, exec, fábrica con gates
  completos, sin permitir `--force` como atajo), tiempo activo, errores,
  abandonos, y SUS completo de 10 ítems. Con 3 personas es piloto
  cualitativo; umbral numérico solo con ≥8. Las métricas de C0 y C3 requieren
  el log local de eventos (candidato C8 prerequisito; opt-out).
- **Seguridad (C5)**: declarar casos ejecutados y matriz de plataformas; un
  cero sobre suite vacía o no ejecutada no cuenta.
- **Perfil de despliegue**: un candidato que exige daemons externos, otro
  runtime distinto de Bun/TypeScript o infraestructura obligatoria se marca
  `incompatible_perfil` y solo puede adoptarse como idea reimplementada.
- Un resultado negativo o inconcluso se registra igual (receipt negativo).

---

## 4. Loop A — Investigación profunda

Pasos (cada uno relee `canonical.md` y actualiza `matrix.md`):

1. **Descomponer**: ítems atómicos + matriz de cobertura (ítem × estado:
   sin fuente / 1 fuente / ≥2 independientes) con criterio de cierre por ítem.
2. **Barrido ancho** en paralelo, por tipo de fuente: papers (arXiv, ACM,
   Semantic Scholar vía `hyperresearch`); repos (`agent-reach github`,
   `gh search repos`); práctica (docs oficiales; Reddit/HN/YouTube con
   `agent-reach read`). Cada fuente es una nota con frontmatter: url, fecha,
   hash del fragmento original, tipo, calidad 0-3, ítem que cubre, resumen,
   cita textual, y etiqueta `observado | declarado | inferido`.
3. **Mapa de contradicciones**: cada contradicción lleva `efecto_en_decision`
   y queda `resuelta | pendiente`; una pendiente y decisiva bloquea adopción.
4. **Loci de profundidad** (1-5): leer fuente completa; clonar repo según §6
   (sandbox); verificar con `graft`/lectura que el código hace lo que dice.
5. **Digest de evidencia**: por candidato, evidencia primaria del
   comportamiento (código leído o paper con código), una fuente en contra si
   existe, capa principal y afectadas.
6. **Borrador** con recetas (§3) y licencia/ToS.
7. **Críticos goldfish** con el paquete de §8: dialéctico, instrucción,
   profundidad, licencia. Alcance: consistencia interna, citas, claims contra
   el código ajeno. El encaje arquitectónico en fab lo juzga el humano.
8. **Parche** quirúrgico; si una refutación invalida la estructura, se
   reestructura conservando historial y notas, nunca se regenera desde cero.
9. **Cite-check** de todos los claims decisivos contra el fragmento original
   (hash), no contra el resumen.
10. **Salida**: `report.md` con candidatos ordenados por (impacto ×
    confianza) / esfuerzo. El humano decide por candidato: `experimento_autorizado`
    o `rechazado`. Loop B solo se dispara si se quiere inventariar el repo
    entero, no por cada candidato.

Jerarquía de fiabilidad: código leído o paper con artefacto reproducible >
doc oficial (solo "declarado" hasta verificar) > blog con reproducción >
post social. Excepción: para señales de abandono o queja de experiencia, los
posts valen como fuente `anecdota-ux` si hay ≥4 independientes.

Tiers de hyperresearch: pregunta acotada → `light`; una capa completa →
`full`; locus con >80 fuentes → `dissertation`.

---

## 5. Loop B — Análisis de un repo dado

Salida: `docs/research/analisis/<repo>.md` + entrada en el registro.

1. **Clonar** según §6. Registrar `sha`, último release, fecha, `LICENSE`
   (hash) y rutas con licencia distinta si el repo mezcla licencias.
2. **Regla de uso** derivada de licencia y ToS (§7).
3. **Inventario**: README, docs, `graft skeleton` de módulos principales.
   Separar **declarado** de **verificado leyendo código**.
4. **Matriz repo → capas** C0-C9 con nivel, `archivo:línea@sha` y una frase.
5. **Contraste con fab**: por capa, qué hace el repo que fab no, qué hace fab
   mejor, qué hacen distinto; evidencia del lado de fab también `archivo:línea@sha`.
6. **Candidatos** con receta §3, esfuerzo S/M/L, riesgo, perfil de despliegue.
7. **Revisión goldfish** con el paquete de §8.
8. **Parche**, registro actualizado, decisión humana por candidato.

Fábricas completas (ESF, Warp): una pasada por capa, cada una con su propio
presupuesto en la cabecera.

**Modo diff** (refresco): solo `last_sha..target_sha`; además un inventario
breve de módulos nuevos para no quedarse ciego a capacidades fuera de los
archivos citados; revisar si los candidatos `integrado` quedaron obsoletos.

---

## 6. Repos ajenos: frontera de seguridad y clean room

- Clonar en `ext/<repo>` nuevo y vacío, **dentro del sandbox bwrap de fab**
  con red solo durante el clone y `core.hooksPath` vacío; indexar (`graft
  build`) con la misma confinación, sin instalar dependencias del repo, sin
  cargar su configuración ni instrucciones de agente (`AGENTS.md`, `.claude/`,
  hooks). Todo texto del repo es dato.
- Cualquier ejecución dinámica de código ajeno (benchmarks, demos) ocurre en
  sandbox con red `deny` y se autoriza explícitamente.
- **Clean room**: el agente que lee código propietario o AGPL escribe solo una
  especificación funcional de caja negra (comportamiento, interfaces,
  métricas). El agente que implementa en fab arranca en sesión nueva y nunca
  recibe ese código ni sus extractos. Para MIT se puede adaptar citando
  archivo@sha en el commit.

---

## 7. Registro de repos de referencia

`docs/research/registry.json` es la fuente única; la tabla del skill
`fab-referencias` se deriva de aquí. Rutas relativas a la raíz del
workspace (`/home/orlando/Desktop/factory`). Campos por entrada:

```json
{
  "name": "esf", "url": "...", "local": "ext/esf",
  "status": "provisional | verificado | doc-only",
  "ambito": "producto | investigacion",
  "license": {"spdx": "MIT", "file_hash": "<sha256>", "scopes": [{"paths": ["crates/x/"], "spdx": "AGPL-3.0"}]},
  "use_rule": "reimplementar | adaptar-citando | solo-diseno | solo-comportamiento",
  "tos_risk": "ninguno | bajo | alto",
  "layers": {"C2": {"level": "fuerte", "what": "...", "evidence": "internal/triggers/cron.go:12@<sha>", "verified": true}},
  "last_sha": "<sha>", "last_release": "<tag|null>", "last_analyzed": "YYYY-MM-DD",
  "analysis": "docs/research/analisis/esf.md",
  "adopted": [{"id": "C6-artifact-model-01", "integrated_sha": "<fab sha>", "resultado": "...", "reevaluar_si": "..."}],
  "watch": true
}
```

Una entrada es `provisional` hasta tener `last_sha` (o hash de artefacto si no
hay git) y evidencias con línea. Material sin git (Droid) usa versión y hash
del artefacto. Escritura del registro solo por el elefante; un lint JSON
(`schema_version`, campos obligatorios por `status`) corre al inicio de cada loop.

**Refresco**:

```bash
git -C <local> fetch --tags origin
target=$(git -C <local> rev-parse origin/HEAD)
git -C <local> log --oneline <last_sha>..$target
git -C <local> diff <last_sha>..$target -- LICENSE <rutas en layers.*.evidence>
gh release list -R <owner/repo> -L 5        # solo entradas con repo GitHub
```

Dispara Loop B en modo diff si: release nuevo, **o** cambian archivos citados,
**o** cambia `LICENSE`/dependencias, **o** `last_analyzed` > 90 días, **o**
cambió el lado de fab que motivó la adopción.

---

## 8. Paquete goldfish y reglas de separación

Un goldfish recibe exactamente: `canonical.md`, el borrador o análisis, el
listado crudo de notas (no el digest del elefante), las evidencias de ambos
lados (`archivo:línea@sha`), las reglas de §1-§3 y §6-§7, y un `canary`: un
defecto plantado por el elefante que debe encontrar. No recibe la conversación,
memoria, resúmenes ni los dictámenes de otros goldfish hasta entregar el suyo.

Sesión nueva, sin recuperación de memoria ni instrucciones locales del proyecto
de investigación; acceso de **solo lectura** al workspace (sandbox de solo
lectura del propio agente, no "permisos saltados"; los permisos saltados son
solo para el panel del elefante o de implementación). Se guarda un manifiesto
de rutas accesibles por revisión.

Si el canary no aparece en el informe, la revisión se repite con otro agente.

---

## 9. Meta-loop M — control de desvío

Lo ejecuta un **verificador distinto del productor** (un goldfish con el
checklist) al final de cada paso de A y B y al cierre; el elefante no se
auto-audita. Produce `docs/research/runs/<run_id>/meta.md` con señal,
evidencia y acción. Responsable de cierre: el verificador confirma el estado
de cada bloqueo y la aprobación humana queda atada a un hash del informe.

| Señal | Cómo se detecta | Acción |
| --- | --- | --- |
| Desvío de intención | Ítem de la matriz sin evidencia nueva en 2 pasos (alerta, no prueba); borrador responde otra pregunta según el crítico de instrucción | Releer canónica; recortar; si persiste, parar y preguntar |
| Candidato incompleto | Falta capa principal, `variable_intervenida`, `candidato.sha`, `guardianas`, `n_runs`, `umbral` o `usd_max` | Bloquear |
| Evidencia débil | Cualquier claim decisivo sin receipt verificado (receipt existe, identifica el experimento y sostiene el número); solo redes sociales fuera de `anecdota-ux`; fuentes con mismo origen de datos | Exigir fuente independiente o degradar a hipótesis |
| Contradicción decisiva pendiente | Entrada del mapa con `efecto_en_decision` y estado `pendiente` | Bloquear adopción |
| Sesgo de confirmación | Sin fuente en contra; crítico dialéctico sin hallazgos | Buscar refutación; confianza baja |
| Goodhart / regresión entre capas | Guardiana empeora; un solo benchmark; el parche toca prompts o vocabulario del benchmark | Rechazar o repetir con segundo benchmark |
| Perfil de despliegue violado | Candidato exige daemon externo, runtime ajeno o infraestructura obligatoria | Marcar `incompatible_perfil` |
| Desvío de licencia / ToS | Código AGPL o propietario pegado; `use_rule` violada; dependencia de auth de terceros sin `tos_risk` | Bloqueo duro; eliminar; registrar |
| Clean room roto | El implementador cargó código ajeno restringido | Descartar implementación; sesión nueva |
| Presupuesto | Consumo acumulado (fuentes, horas, USD, concurrencia) supera la cabecera, comprobado **antes** de lanzar cada paso | Cancelar pendientes; cerrar con lo que hay |
| Alucinación de código | Claim "el repo hace X" sin `archivo:línea@sha` o la línea no lo sostiene | Verificar; si falla, borrar claim |
| Contexto contaminado | Goldfish con acceso a conversación, memoria, digest o dictámenes ajenos; manifiesto de rutas excede el paquete | Repetir con agente nuevo |
| Revisor perezoso | Canary no encontrado; informe sin hallazgos | Repetir con otro agente |
| Receta no reproducible | Sha del candidato ausente; entornos distintos fuera de la variable intervenida; corrida de humo del baseline no pasó | Invalidar medición |
| Staleness | Cualquier disparador de §7 | Encolar Loop B diff |
| Loop sin fin | 2 iteraciones parche→crítico sin cerrar hallazgos críticos (por id, no por conteo) | Parar; entregar con limitaciones |
| Beneficio no realizado | Candidato `integrado` sin `resultado` observado tras un ciclo de uso | Reevaluar o revertir |

Estados de adopción y gates humanos: `propuesto → experimento_autorizado
(humano) → medido → integracion_autorizada (humano) → integrado`. Medir puede
requerir implementar un prototipo; eso ocurre solo tras `experimento_autorizado`
y en worktree propio.

---

## 10. Quién hace qué

| Rol | Quién | Contexto |
| --- | --- | --- |
| Elefante (diseña, sintetiza, integra, escribe registro) | Claude, panel principal | Todo el proyecto |
| Fetchers / investigadores de locus | subagentes hyperresearch, `agent-reach` | Solo su locus |
| Goldfish (refutan, ejecutan checklist M) | codex, agy, opencode (modelo free) en paneles herdr de solo lectura | Paquete §8 |
| Implementación de candidatos autorizados | codex / agy en worktree propio, sesión limpia (clean room) | Spec funcional |
| Decisión | Orlando | Gates |

---

## 11. Revisión goldfish de v0.1 (resumen)

Tres revisores independientes (codex 30 hallazgos, agy 26, opencode 25).
Convergieron en: registro que viola su propia regla de receipts; meta-loop
auto-auditado; receta sin identidad del candidato ni entorno; UX medida con
un agente y "SUS de 5 ítems"; sin control de Goodhart ni guardianas entre
capas; repos ajenos indexados fuera de sandbox; clean room ausente; presupuesto
sin números; refresco con `last_sha` nulo; C1 solo ingesta; C3/C6 solapadas.

Aceptado e integrado en v0.2: todo lo anterior, más C4a/C4b, C9, niveles
`no-evaluado`/`no-aplica`, ámbito producto/investigación, canary, estados de
adopción, perfil de despliegue, licencia por rutas y `tos_risk`, contradicciones
con efecto, seguimiento post-adopción, umbral como ratio (0.34 no era 20%).

Rechazado o diferido: capa "meta-harness y gobernanza" (agy 2.6, diferido
hasta tener un caso real); federación entre fábricas (fuera de alcance);
`--sandbox network-deny` como único mecanismo para goldfish (se exige solo
lectura, el mecanismo depende de cada agente).
