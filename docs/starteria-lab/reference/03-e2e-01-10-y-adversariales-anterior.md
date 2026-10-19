# E2E-01 a E2E-10

### E2E-01 — Founder con oportunidad propia

1. **Recorrido, estados y transiciones:** En T0: intención → interpretación provisional → checkpoint → handoff confirmado → perfil Initiative explícito elegible → auth/claim → InitialReview → confirmRoute → Overview → Steps 0–4 → decisión/continuidad. T-Future no puede convertir registro en autoridad por sí mismo.
2. **Inputs, actores y autoridades:** Sólo idea, objetivo y restricciones al inicio; evidencia y resultados se incorporan cuando el usuario los obtiene. Actor founder/owner, con autoridad únicamente sobre su iniciativa. Decisor requerido por gobernanza; IA propone.
3. **Outputs, persistencia y decisión habilitada:** Salida inicial: interpretación e incertidumbres; después Brief/evidencia/paquete. Conservar session/revision/provenance y vínculo Project; decisión habilitada: investigar/continuar/iterar/cerrar, no aprobar beneficio por terminar Step 4.
4. **Dependencias frontend/backend/IA y evidencia:** Frontend Entry/Auth/Review/Overview → session/claim/route-confirmation → Adaptive Core/Truth; AI sólo razonamiento previo. E01–04/E08–12.
5. **Fallo, contraste y resultado:** CONFIRMED parcial de módulos; F-04/05/06/10/13. CONTRACT_CONFLICT condicional F-21: el founder explícito puede encajar en excepción ADR-003, pero 133G sigue diferida. Pruebas review/overview/core y P08; no PASS E2E real.

### E2E-02 — Owner con cuatro iniciativas

1. **Recorrido, estados y transiciones:** Crear/importar cada iniciativa → listado Mis iniciativas → seleccionar/retomar → ciclo propio. El cuarto elemento no cambia rol ni obliga Portfolio; CTA voluntario sólo si su experiencia está definida.
2. **Inputs, actores y autoridades:** Se añade una iniciativa por evento; nunca usar número de proyectos como prueba de mandato corporativo. Owner conserva scope; mentor/observador no hereda aprobación.
3. **Outputs, persistencia y decisión habilitada:** Listado con estado/owner/próxima acción y fuentes por iniciativa; no duplicar identidad al vincular. Permite decidir dónde continuar, no priorizar cartera corporativa automáticamente.
4. **Dependencias frontend/backend/IA y evidencia:** Dashboard y rutas initiatives/projects; backend Project, InitialReview, billing/permissions, E01/E08/E10/E14. Esquemas Project/TeamMember/InitiativePortfolioMeta existentes.
5. **Fallo, contraste y resultado:** PARTIAL_STATIC: no se encontró regla de auto-upgrade por volumen en las rutas/servicios examinados, pero no se ejecutaron cuatro creaciones reales. F-04/16 y D-04. Tests de UI no prueban esta invariante global; NEEDS_RUNTIME.

### E2E-03 — Gestión voluntaria como Portfolio propio/equipo

1. **Recorrido, estados y transiciones:** Owner elige organizar → mostrar alcance/beneficio → validar entitlement separado de grant → crear/seleccionar espacio legítimo → vincular existentes → Home. Variantes: espacio personal/equipo o Portfolio organizacional autorizado.
2. **Inputs, actores y autoridades:** Cuatro iniciativas existentes, miembros invitados y deseo explícito. Pago no es autoridad; pertenencia a empresa tampoco basta para poderes corporativos. No inferir aprobación por email.
3. **Outputs, persistencia y decisión habilitada:** Vínculos a objetos existentes y scope explícito, sin duplicar proyectos; conserva owner/provenance/historia y habilita priorización limitada al espacio acordado.
4. **Dependencias frontend/backend/IA y evidencia:** UI de ampliación voluntaria/Portfolio → entitlement+organization grants → metadata/links. E04/E06/E14; T-SF ofrece selector contextual, no contrato de workspace personal.
5. **Fallo, contraste y resultado:** CONTRACT_CONFLICT F-20/D-04. Evaluado conceptualmente en ambas variantes; no target aprobado para declarar bug por CTA ausente. F-01–03 impedirían aislamiento fiable de cualquier variante.

### E2E-04 — Solicitar autoridad corporativa al Admin

1. **Recorrido, estados y transiciones:** Solicitud → pendiente → revisión por autoridad competente → aprobar/rechazar → membership/grant explícito → acceso revalidado → revocar cuando cambie mandato.
2. **Inputs, actores y autoridades:** Identidad y organización alegadas no equivalen a permiso; admin legítimo decide. Evitar autoasignación, correo corporativo como prueba suficiente y pago como rol.
3. **Outputs, persistencia y decisión habilitada:** Decisión de acceso auditable y grant por organización; no genera verdad estratégica ni iniciativa. Conservar emisor, receptor, scope, motivo y revocación.
4. **Dependencias frontend/backend/IA y evidencia:** Auth/roles/scopedPortfolioAccess y UI de administración; E04/E14. La existencia de roles y grants no demuestra workflow de solicitud/issuer completo.
5. **Fallo, contraste y resultado:** PARTIAL_STATIC: primitivas verificadas; aprovisionamiento de 114F fuera de scope: D-05. F-01–03 seguridad actual, F-17 lifecycle por verificar. No se concedió ningún permiso ni envió solicitud.

### E2E-05 — Empresa sin iniciativas: diversificar negocio

1. **Recorrido, estados y transiciones:** Meta → Entry/reverse alignment → 114D → 114E → auth/grant → Setup → contexto/propuesta de Frente → retos justificados → confirmación humana → capacidad/equipo → invitar → aceptar → iniciar → Overview/Steps → DecisionPackage Portfolio.
2. **Inputs, actores y autoridades:** Al inicio sólo meta y restricciones declaradas; baseline/KPI/owner desconocidos permanecen abiertos. PL autorizado confirma estructura; owner acepta/inicia; IA no crea objetos por inferencia.
3. **Outputs, persistencia y decisión habilitada:** Frentes/retos con rationale, fuente y pendiente de aclaración; assignment separado de iniciativa; después evidencia y decisión. No fijar ROI o plazo sin base.
4. **Dependencias frontend/backend/IA y evidencia:** Entry / 114F/bootstrap/P3/framing/Portfolio/handoff/Core. E02–07/E10–12; T-SF añade priorización de candidatos → promoción a draft con front existente y scope.
5. **Fallo, contraste y resultado:** PARTIAL_STATIC+UNIT:114F y handoff robustos en tests; F-01–03/08/10/13. T-SF mejora la promoción gobernada, no resuelve org/grant inicial ni creación de un Frente cuando falta. NEEDS_RUNTIME para recorrido completo y proveedor.

### E2E-06 — Dieciocho iniciativas y tres objetivos

1. **Recorrido, estados y transiciones:** Importar 18 → conservar origen → clasificar sin validar automáticamente → relacionar/confirmar objetivos → detectar cobertura/solapamientos → resolver duplicados humano → asignar owner → reconstrucción retrospectiva → gates/evidencia → decidir → beneficios.
2. **Inputs, actores y autoridades:** Archivos/trabajo previo sólo disponibles al importarlos; no completar Step 1 con evidencia que todavía no existía. Las fechas capturadas pueden ser anteriores, con procedencia real. PL/owner/validator con scopes separados.
3. **Outputs, persistencia y decisión habilitada:** Inventario trazable y relaciones sugeridas frente a confirmadas, incertidumbres y gates retrospectivos. Mantener identificadores existentes; actividad previa no equivale a aprobación Step.
4. **Dependencias frontend/backend/IA y evidencia:** BootstrapImportBatch/WorkItem/ProposedMutation, P3, InitiativePortfolioMeta/Overlap, Reconstruction, Truth, Core. E05/E06/E10–13/E16.
5. **Fallo, contraste y resultado:** PARTIAL_STATIC: modelos de intake/import presentes; no importación real de 18. F-09 reproduce falsa contradicción, F-08/10/13. D-12 permite variante SF para priorizar capacidad. Fuente de 31 iniciativas ausente no invalida catálogo de 18 iniciativas ni lo convierte en sustituto.

### E2E-07 — Recurso o validación externa sin Portfolio obligatorio

1. **Recorrido, estados y transiciones:** Owner delimita petición → generar brief mínimo → compartir con destinatario acotado → aceptar/rechazar/expirar → respuesta → clasificar declaración/verificación → actualizar evidencias/decisión.
2. **Inputs, actores y autoridades:** No exponer cartera ni datos ajenos. Actor externo recibe permiso mínimo; ver o no responder no es aprobar. Verificación competente requiere identidad/provenance acordadas.
3. **Outputs, persistencia y decisión habilitada:** Brief con pregunta/decisión/contexto necesario y respuesta trazable. Conservar alcance de lo compartido, acceso/revocación y dudas no contestadas.
4. **Dependencias frontend/backend/IA y evidencia:** HelpRequest/invitations/Truth pueden aportar piezas; Assignment interno no demuestra intercambio externo propuesto. E07/E11/schema HelpRequest; D-10.
5. **Fallo, contraste y resultado:** DEFINED_PARTIAL/NEEDS_EVIDENCE. Variante de cuenta limitada frente a enlace acotado pendiente. F-03/F-15/F-17 relevantes. No se envió correo ni se activó enlace; no PASS.

### E2E-08 — Solución primero con evidencia insuficiente o negativa

1. **Recorrido, estados y transiciones:** “Implementar IA” → reverse alignment tardío si surge en aclaración → delimitar resultado → Step 0/1 → contraste → evidencia insuficiente/contradictoria → iterar/pausar/cerrar con humano competente → learning.
2. **Inputs, actores y autoridades:** Proveedor/plazo declarados no son evidencia de necesidad. No usar resultado negativo futuro para mejorar primer encuadre. El decisor puede parar; IA no impone éxito del proyecto.
3. **Outputs, persistencia y decisión habilitada:** Claims y soporte/contradicción separados, gates hard frente a soft, recomendación y registro de decisión/razón; aprendizaje útil aunque no haya beneficio.
4. **Dependencias frontend/backend/IA y evidencia:** Entry question planner/reverse alignment, InitialReview, Truth/política de checkpoints, DecisionAuthority, PortfolioLearning. E02/E08/E10–12.
5. **Fallo, contraste y resultado:** PARTIAL_UNIT: tests verifican autoridad/readiness; F-05/07/12 y F-22. F-09 si se reconstruye trabajo previo. No proveedor real ni validación humana experiencial; no se declara que IA razone mejor que paráfrasis.

### E2E-09 — PL asigna mandato a persona/equipo

1. **Recorrido, estados y transiciones:** Reto/mandato / KPI → assignment → delivery → sent / viewed → accepted o rejected (con razón) → respuesta PL → start por owner → materializar / vincular iniciativa → Overview con datos heredados/Step 0 → bloqueo / reporting → decisión Portfolio.
2. **Inputs, actores y autoridades:** Asignar no acepta; aceptar no inicia. Observador/ejecutor no es owner ni aprobador. Verificar email/identidad, versión, idempotencia y revocación; estado activo sigue D-03.
3. **Outputs, persistencia y decisión habilitada:** Assignment + eventos + proyección con fuentes; un Project al iniciar cuando aplique, sin duplicado. Brief hereda mandato pero puede señalar contradicciones y restricciones.
4. **Dependencias frontend/backend/IA y evidencia:** HandoffInvitation/Assignment/ResponseCommand, Project, Adaptive Core, Home. E06/E07/E09–12.
5. **Fallo, contraste y resultado:** PARTIAL_UNIT con responses/atomicity; rechazo aceptado como resultado legítimo. F-02/03/08/17; el camino canónico existe y la cuarentena de rutas legacy evita equiparar /projects/new?challengeId al nuevo handoff. No email real ni runtime DB.

### E2E-10 — Partner y cliente prueban valor del producto

1. **Recorrido, estados y transiciones:** Seleccionar caso representativo → consentimiento/roles → rutas existentes de Portfolio o Initiative → trabajar con inputs reales progresivos → paquete/decisión → seguimiento → comparar valor con alternativas.
2. **Inputs, actores y autoridades:** Partner no recibe autoridad del cliente por ser partner. Separar declaración comercial, evidencia de uso y beneficio. No crear un nuevo Core ni prometer funciones fuera de release.
3. **Outputs, persistencia y decisión habilitada:** Output revisable que cambia una decisión, trazabilidad y continuidad; medir tiempo, calidad, pérdida de contexto y resultados; feedback futuro no cambia evidencia de pasos anteriores.
4. **Dependencias frontend/backend/IA y evidencia:** Todas las rutas pertinentes; analytics/requestIDs/costes; E01–16. Ningún test unitario sustituye validación comercial.
5. **Fallo, contraste y resultado:** CONCEPTUAL_ONLY para valor real; F-22 y F-15. T-SF/T3 proyectan mejoras pero no prueban diferenciación. Sin entrevista ni piloto con cliente; no PASS de mercado.

## Escenarios adversariales

| ID | Perturbación | Invariante esperado | Evidencia | Resultado |
|---|---|---|---|---|
| A-01 | Cambiar KPI/alcance/restricciones con ciclo activo | Versionar; revisar dependientes sin overwrite | P05; E06/E10 | DEFECTO F-08; alcance de campos del probe delimitado |
| A-02 | Owner deja organización después de aceptar / iniciar | Revalidar; reasignar con historia; evitar ejecución huérfana | E07/E10 | NEEDS_EVIDENCE F-17 |
| A-03 | Invitación rechazada | Razón requerida; respuesta PL; ningún Project por rechazar | tests de response/atomicity; E07 | PARTIAL_UNIT; sin email real |
| A-04 | Grant revocado mientras 114F escribe | Lock, revalidación y rollback; denegación por defecto | E04 :152; tests seleccionados de scope | PARTIAL_STATIC; DB concurrente no ejecutada |
| A-05 | Respuesta del servidor perdida tras primer análisis | Estado incierto; GET de estado; preservar texto; no POST ciego | KAN-151: 15 pruebas browser; 71 tests de Experience/storage | PASS_SYNTHETIC acotado |
| A-06 | Fallo del proveedor IA | Modo/error visible; reintento seguro; sin inventar resultado | E16; F-07; fallo simulado en navegador | DEFECTO transparencia; proveedor real UNKNOWN |
| A-07 | Reintento o doble clic en start/confirmación | Un solo evento/objeto; conflicto si cambia el payload | atomicidad de handoff; P08; browser | Handoff PASS parcial; InitialReview: DEFECTO F-04 |
| A-08 | Evidencias contradictorias | Relacionar claim y periodo; separar tradeoff | P07; Truth/tests de readiness | DEFECTO F-09; Truth canónico protege progresión |
| A-09 | Evidencia insuficiente con presión para avanzar | Hard gate bloquea; soft gap visible; el humano no falsea Truth | decision-readiness; política de checkpoints | PARTIAL_UNIT; no afirmación de todos los gates |
| A-10 | Importación avanzada Step 3 con Step 1 incompleto | Preservar trabajo previo; gates retrospectivos; no autovalidación | E13/P07; schema ImportBatch | PARTIAL_STATIC; F-09 |
| A-11 | Cambio de contexto después del handoff | Una nueva revisión obliga a revalidar los bindings de 114D/114F | E04; guardas de snapshot obsoleto | PARTIAL_STATIC; sin inventar endpoints |
| A-12 | Modificar evidencia después de decisión | Snapshot histórico; señal de vigencia; reevaluación explícita | E11/E12; FKRestrict | NEEDS_EVIDENCE F-18 |
| A-13 | Estimar 81k y pedir realized | Rechazar sin medida operacional; sin doble conteo | P06/E11 | DEFECTO F-10; L6 completo ausente: F-13 |
| A-14 | Misma persona con roles distintos en dos organizaciones | Scope por request/recurso; sesiones separadas | P03/P04; fuente de contexto SF | DEFECTOS F-01–03; SF no garantiza reparar las lecturas canónicas |
| A-15 | Observador intenta aprobar; mentor niega y sponsor quiere continuar | Resolver autoridad según governance/gates; sin atribución automática | decision-authority/tests de readiness; E10 | PARTIAL_UNIT; matriz de todos los roles: NEEDS_RUNTIME |
| A-16 | Última iniciativa desvinculada de un reto activo | Alerta/revisión o estado activo preparatorio, según contrato | tests de cobertura de retos; F-19 | DECISION_REQUIRED D-03 |
| A-17 | Prompt injection en input/documento | Tratar como input; no escalar autoridad ni fuentes; no ejecutar | E16; autoridad del servidor | CONCEPTUAL; proveedor no probado; sin intento de exfiltración |
| A-18 | Duplicados semánticos de alineamiento | Sugerir solapamiento; fusión sólo con decisión humana y procedencia | schema InitiativeOverlap/ProposedMutation; E05 | PARTIAL_STATIC; no se declara defecto por falta de prueba |
| A-19 | Fallo parcial de creación | Atomicidad o recuperación durable por frontera | P08; transacción de promoción SF; escritura 114F | DEFECTO F-04; sin certificación global |
| A-20 | Handoff/initialreview antiguo seleccionado | Política explícita de vigencia/historia | P09; E04: checks de última revisión | DECISION_REQUIRED D-09; 114F distinto de InitialReview |
| A-21 | Importar original confidencial y pedir borrado | Verificar redacción, retención, derivados y proveedor | E16/TTL de PDF público; BERE-T08 | NEEDS_EVIDENCE F-15; ningún archivo real subido |
| A-22 | Stop de clarificación sin suficiencia / Guided anticipado | Stop no habilita COP-09 por sí solo; opt-in en estado autorizado | KAN-145 / V-145-01; ADR-002 | CONTRACT_CONFLICT F-23; variantes D-11 |

El control de snapshot revisado para 114F no demuestra que InitialReview aplique idéntica política (A-11 y A-20).

## Cobertura funcional: trabajo y valor por experiencia

Cada fila explicita objetivo del usuario, entendimiento/trabajo del sistema, salida/información conservada, decisión/siguiente paso y límite observado. Las rutas existentes no bastan para un PASS de utilidad.

| Experiencia | Usuario necesita | Entiende/trabaja | Entrega/conserva | Decisión → después | Evidencia/límite |
|---|---|---|---|---|---|
| Landing | Entender oferta | Presenta propósito y opcionalidad; no analiza | Copy/CTA; sin verdad canónica | Elegir Entry, login o demo | E01/ADR-006; visual KAN-144 futuro |
| Portfolio Entry | Ordenar necesidad | Interpretación provisional contextual | Session/input/revisión/provenance | Aclarar o confirmar | E02/E03; recuperación KAN-151 probada |
| IntentDetection | Expresar intención libre | Clasifica intent, origen y frame | Initial_entry_state/current_frame | Pregunta material o ruta | Agent/skills; proveedor UNKNOWN |
| ContextExtraction | Conservar hechos y números | Separa declaración e inferencia | Fuentes/unknowns/contextrevision | Aclarar lo importante | E16/F-14; sin traza real |
| ReverseAlignment | Justificar solución | Conecta solución y resultado, incluso cuando aparece después | Hipótesis/gaps, no Step 2 | Continuar / reformular | E02/skill 03; runtime IA pendiente |
| ClarificationSessions | Resolver incertidumbre | 0–1 pregunta activa, budget/stop | Respuestas y «no lo sé», sin bucle | Checkpoint/Guided con opt-in | E03/ADR-002; D-11 |
| Handoff114D/E | Revisar primer abordaje | Síntesis confirmable y límites | Artifactversion/contextrevision | Confirmar/corregir/continuar | E02/E04; integrados |
| Auth/Claim/registro | Retomar identidad y contexto | Ownership y perfil; no autoridad por registro | Session claim/versionbinding | Continuación autorizada | E04; 133G/provisiónD02/D-05 |
| PortfolioSetup | Preparar contexto mínimo | Reutiliza handoff confirmado | Bootstrap/anchor/provisional | Importar / encuadrar / ir a Home | E04/E05; configuración mínima, no exhaustiva |
| PortfolioHome | Atender cartera y decisiones | Agrega frentes, lectura, handoffs y aprendizajes | Read models con fuentes | Siguiente intervención | E06; F-01/F-02/F-12 |
| Contexto organizacional | Aplicar mandato y restricciones | Versiones CompanyContext y contribuciones | ContextSnapshot/Source | Confirmar / revisar mandato | Schema; scopedauthorityE04; F-08 |
| Frentes estratégicos | Relacionar objetivos con acción | CRUD/lectura; propuesta humana | Front/KPI/contexto | Delimitar retos | E06; F-03/F-08 |
| Retos | Delimitar foco y cobertura | State/coverage/assignments | Challenge/coverage | Preparar/activar/revisar | E06/E07; D-03 |
| Strategic Framing WIP | Elegir qué atender | Lentes/gaps/capacidad; promoción humana | Candidatos/snapshots/Challenge draft | Priorizar/promover, noejecutar | E15; T-SF condicional |
| Activación | Comprometer responsables | Invitar, aceptar e iniciar separados | Assignment/event/responsecommand | Iniciar una iniciativa | E07; tests; F-03/F-17 |
| Importación/clasificación | Recuperar cartera existente | Intake/batch/proposedmutations | Fuente/workitem/identity | Confirmar relaciones y owner | E05/E13; 18 no ejecutadas |
| Cobertura/solapamientos | Ver huecos y redundancia | Derivedcoverage/overlap | Links/unknowns/propuestas | Investigar / combinar con decisión humana | E06; coverageunit; sin PASS global |
| Seguimiento/AttentionQueue | Ver intervención material | Signals/AttentionItem/exitcondition | Owner/source/status | Resolver pedido y registrar | E06/E10/E11; F-08 |
| Decisiones/reporting | Comparar evidencia y decidir | DecisionRequest/readiness/ExecutiveOutput | Snapshot/actor/rationale | Decidir/continuar/reportar | E10–12; F-10/F-18 |
| Mis iniciativas | Retomar mi trabajo | Listado/estado/owner | Project/TeamMember | Crear/abrir/retomar | E01/E14; E2E-02 parcial |
| Creación/importación de Initiative | Convertir entrada en borrador | Review/PDF/propuestas, confirmación | Original/snapshot/Projectbinding | Revisar antes de iniciar | E08/E16; F-04/F-15 |
| Revisión inicial | Obtener lectura crítica | Resumen/crítica/preguntas/propuesta | InitialReviewSnapshot/chat | Confirmar ruta / corregir | E08; F-05–07/F-14 |
| Overview | Entender dónde estoy | Contexto/ruta/acciones | Project/ciclo/mastercontext | Revisar misión / empezar | E09; F-11/F-16 |
| Step 0 | Enmarcar decisión | Brief/condiciones/restricciones | Configuration/output/checkpoints | Confirmar Brief → Step 1 | E10; F-05/F-08 |
| Step 1 | Sustentar foco | Truth/evidence/readiness | Claims/validations/sourceRefs | Foco suficiente → Step 2 | E10/E11; tests Truth |
| Step 2 | Preparar acción y medición | Diseño y checkpoints de evidencia | Output/plan/metric/threshold | Ejecutar contraste → Step 3 | E10; política de evidencia inspeccionada |
| Step 3 | Observar realidad | Resultados y contradicciones | Evidence/capture/validation | Aprender/reformular → Step 4 | E10/E11; proveedor/realidad no probados |
| Step 4 | Preparar decisión y siguiente estado | Paquete/síntesis/routing de cierre | DecisionPackage/requests/snapshots | owner_completed o portfolio_presented | E10/E12; F-11/F-13 |
| AdaptiveCycle | Adaptar sin perder historia | CriticalChange/reconfiguration | CycleStepState/configversions | requires_review / nuevo ciclo | E10; F08frontera aguas arriba |
| Evidencias/validaciones | Sostener claims | Vínculos y validadores con scope | SourceRef/TruthClaim/Validation | Readiness/decision | E11; F18pendiente |
| BenefitTracking | Comprobar valor real | Piezas ImpactAssertion/continuation | Estado estimado / validado / realized | Revisión operacionalL5/L6 | E11/E12; F-10/F-13 |
| Aprendizaje organizacional | Reutilizar lo aprendido | PortfolioLearning/proyección | Fuente/cierre/aprendizaje | Mejor nuevo encuadre | E06/E12; F-12; sin entrenamiento automático |

## Transversales

| Dimensión | Evaluación del target accesible |
|---|---|
| Roles y permisos | E04/E07/E10/E14; owner, PL, mentor, sponsor, admin, observador separados conceptualmente. F-01–03 yF17 impiden certificar aislamiento uniforme. |
| Autoridad humana/IA | Confirmación de interpretación no otorga autoridad organizacional. Truth/DecisionAuthority protegen partes; F-05 mezcla semántica downstream. |
| Persistencia/provenance | Schemas versionados y fuentes presentes; F-04, F-05, F-08, F-14, F-18 muestran límites o verificaciones abiertas. |
| Versionado | 114F verifica contextRevision/artifactVersion; InitialReview puede aceptar snapshot anterior explícito(P09); D-09. |
| Seguridad | Lectura/escritura scoped incompletas. PDF sanea paths y pide redacción; no se certifica privacidad efectiva. |
| Error/recuperación | 151 mejora la primera solicitud; InitialReview falla en finalización parcial; aprendizaje falla comoempty; F-04/F-07/F-12. |
| Idempotencia | Handoff y114F tienen mecanismos explícitos; nunca se extrapola al sistema completo. |
| Analytics/observabilidad | ModelExecution, Run, AuditLog, UsageEvent y requestId aportan piezas. No se observaron dashboards de producción, SLO, alertas ni evaluación de coste/latencia. |
| Aprendizaje | PortfolioLearning existe; reutilización y atribución requieren validación; no se asume entrenamiento LLM con datos de clientes. |

## Reconciliación de la Gap Matrix original

| Gap | Objetivo | Resultado | Evidencia/estado |
|---|---|---|---|
| G-01 | Initiative-first | Excepción explícita permitida; default Portfolio | F-21 / D-02; parcial |
| G-02 | Mis iniciativas sin auto-upgrade | Listado presente; regla global no certificada E2E | E2E-02; NEEDS_RUNTIME |
| G-03 | CTA voluntario Portfolio | Experiencia de equipo/propia propuesta | D-04; target aprobado UNKNOWN |
| G-04 | Pago ≠ autoridad | Entitlement separado de grant; CRUD no limita todo el scope | F-01–03; no se probó un pago |
| G-05 | Portfolio de equipo/área | Conflicto contractual abierto | F-20 / D-04 |
| G-06 | Solicitar rol al Admin | Primitivas de roles/grants; solicitud completa no verificada | D-05 / E2E-04 |
| G-07 | Vincular sin duplicar | Metadata y relaciones presentes; deduplicación de importación E2E pendiente | E2E-06; P08 prueba otra frontera |
| G-08 | Portfolio vacío propone estructura | Bootstrap/P3 y T-SF con promoción humana a draft | E2E-05 / E15; sin inventar objetivos |
| G-09 | Reto activo requiere iniciativa | v0.3 candidata; dos semánticas | F-19 / D-03 |
| G-10 | Asignación por correo y aceptación | Handoff canónico implementado; tests de respuesta/atomicidad | PARTIAL_UNIT; delivery real pendiente |
| G-11 | Steps reutiliza mandato | MasterContext, Overview y handoff presentes | F-05/F-08; traza completa pendiente |
| G-12 | Solicitud externa sin Portfolio | Propuesta no cerrada | D-10; no se declara bug por ausencia |
| G-13 | Decision Package vuelve a Portfolio | portfolio_presented y DecisionRequest/snapshots | E10/E12; tests de autoridad/readiness |
| G-14 | Benefit Tracking posterior a Step 4 | Piezas presentes; ciclo de realización/atribución incompleto | F-10/F-13 |
| G-15 | Visualizador ≠ aprobador | Resolvers de autoridad y roles de miembros presentes | PARTIAL_UNIT; problemas de scope impiden certificación |

NO_VERIFICADO no se convirtió en NO_IMPLEMENTADO por ausencia de tests. G-14 clasifica el ciclo completo tras contrastar rutas/schema/servicios y reconocer sus piezas presentes.

## Journeys J01–J14 del Manifest

| Journey | Casos/variantes | Cobertura |
|---|---|---|
| J01 — Nuevo PL | E2E-05 / A-04/05 | Parcial; provisión D-05 |
| J02 — Cartera >20 | E2E-06; variante de escala | 18 evaluadas conceptualmente; >20 sólo análisis de escala. Caso31 original ausente |
| J03 — Estrategia a trabajo | E2E-05/09 | T-SF condicional; promoción humana |
| J04 — Solución primero | E2E-08 | Reverse alignment; proveedor pendiente |
| J05 — Independiente | E2E-01/02 | Excepción D-02 |
| J06 — Importada avanzada | E2E-06 / A-10 | P07 / F-09 |
| J07 — Crecimiento | E2E-05 | Tipos crecimiento/exploración sin forzar problema; runtime pendiente |
| J08 — Exploración | E2E-08 | Aprendizaje y pausa son resultados legítimos |
| J09 — Múltiples iniciativas por reto | E2E-06 / A-16/18 | Cobertura/solapamiento parcial |
| J10 — Cambio material | A-01/12/20 | F-08/F-18 |
| J11 — Fallos y reintentos | A-05/06/07/19 | KAN-151 navegador / P08 |
| J12 — Cierre y beneficios | E2E-01/05/09 / A-13 | F-10/F-13 |
| J13 — Roles múltiples | E2E-03/04/07/09 / A-14/15 | F-01–03/F-17 |
| J14 — Aprendizaje recurrente | E2E-08/10 | PortfolioLearning presente; F-12/F-22 |
