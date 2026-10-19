STARTERÍA DECISION + LAB — Product Spec de trabajo v0.1
Fecha: 18 octubre 2026. Estado: propuesta a validar; NO contrato Core aprobado ni diagnóstico técnico certificado del Lab bancario.

0. Decisión de producto
Una entrada diagnóstica común (Startería Decision) produce un Decision Brief preliminar y tres modalidades de ejecución: A) propia cuenta, B) Startería Guided, C) Startería Lab. Dentro de C, sólo si se elige, se comparan hasta tres soluciones técnicas adecuadas al problema y se ofrece un paquete Essential, Build o Extended. No mezclar tres rutas de servicio con tres alternativas de solución. El cliente puede no contratar ninguna. Las recomendaciones de IA no son hechos confirmados ni decisiones de inversión.

1. Decision Brief — primera reunión
Input mínimo
Resultado deseado y decisor.
Contexto y restricciones de negocio, métricas, baseline/meta si existen; ausencia explícita si no.
Alternativa actual e intentos previos.
Capacidades reales, disponibilidad de equipo, presupuesto máximo a explorar, plazo y dependencias.
Consentimiento, confidencialidad y fuentes.
Salida observable
Síntesis del estado actual y meta deseada, fuentes por afirmación y supuestos por resolver.
Diagnóstico preliminar, hipótesis de cuello de botella sin afirmaciones de causalidad no probada.
Tabla de rutas A/B/C con rango de coste total (setup, operación y horas internas), ventana, recursos, entregables, nivel de intervención, dependencias, riesgos, criterios de éxito y próxima decisión.
Recomendación y alternativas, con justificación revisable, supuestos que cambiarían la preferencia y libertad de no contratar.
Estado: draft -> reviewed -> client_approved_scope; el brief no constituye aceptación tácita ni contrato de obra.
2. Modalidades de ejecución
A. Cliente por su cuenta
Entregable: Action Brief exportable + presupuesto orientativo y dependencias.
Dueño de ejecución: cliente/proveedor; Startería puede ofrecer check-ins opcionales.
Registro posterior de evidencias voluntario; sin crear artificialmente Initiative/Project.
Gate: aceptación humana de la ruta y recursos propios; advertir si hay dependencias sin cubrir.
B. Startería Guided
Handoff versionado de brief a iniciativa; equipo y Initiative Owner asignados; sponsor/autoridad cuando corresponda.
Core Step 0 contexto y decisión; Step 1 verdad/foco; Step 2 artefacto y medición preparados; Step 3 prueba y evidencia; Step 4 Decision Package. Adaptación por tipo y madurez, sin cinco formularios universales.
Responsabilidades: cliente asegura capacidad, datos, acceso, pruebas y decisiones; Startería proporciona guía, copilot, evidencias, trazabilidad.
Gate: owner acepta; no equiparar notificación, aceptación, creación y comienzo.
C. Startería Lab
Intake: brief aprobado, alcance, límite de coste, plazo, confidencialidad, responsable funcional, usuarios de prueba y restricciones.
Scouting verificable, opciones técnicas comparables y recomendación; la shortlist puede contener 1–3 opciones reales, nunca exigir tres cuando no existen.
Cotización SOW del paquete elegido; humano aprueba presupuesto, alcance, acceso, riesgos y aceptación.
Diseño -> construcción en sandbox -> QA técnico y seguridad -> prueba real autorizada -> iteración <=2 -> paquete de transferencia y decisión.
Lab puede construir y automatizar; no puede asegurar demanda, ROI o validación de mercado mediante tests técnicos/sintéticos.
3. Lab: niveles de producto
Dimensión    Essential    Build    Extended
Alcance    Un supuesto crítico; proxy, prototipo o flujo simple    Aplicación/automatización limitada y usable    Integración y seguimiento delimitados
Construcción    Baja complejidad, infraestructura mínima    Alcance concreto con controles técnicos    Revisión de seguridad, integración, ownership y operación
Validación    Funcional y señales reales cuando haya acceso    Técnica + usuarios reales acordados    Operación acotada y seguimiento observacional
Humano    Revisión antes de entregar    Revisión funcional y QA    Arquitectura/seguridad/operación y decisiones
Iteraciones    Hasta dos ajustes pequeños    Hasta dos rondas priorizadas    Hasta dos ciclos con límites de esfuerzo
Resultado    Demo/proxy + Decision Brief    Solución utilizable según criterios pactados    Entrega e informe de operación conforme a alcance
Protocolo de iteración
V0 = primera entrega. R1 = cambios derivados de evidencias/feedback del primer test. R2 = cambios derivados de segunda revisión. Cada ronda tiene máximo de horas pactado, criterios de aceptación, acceso y autorización explícitos. Nuevas integraciones, pivot, mayor alcance, incidentes regulatorios o cambios materiales requieren change request/cotización. Cerrar después de R2 aunque el resultado sea negativo o inconcluso.

4. Factores de selección (no etiquetas de marketing)
Adecuación de cada nivel = tipo de problema + evidencia inicial + complejidad técnica + dependencias externas + acceso a usuarios/datos + sensibilidad/seguridad + recursos + ventana de decisión. Recomendar no construir si comprar, hacer manualmente o usar un proveedor existente es claramente más razonable. Mostrar escenarios y rangos sin ROI inventado.

5. Interfaz común con el Core
DecisionBrief (versionado; contexto, fuentes, supuestos, objetivo, alternativas, decisión).
ExecutionChoice (A/B/C, confirmación, alcance autorizado).
ExecutionBrief (criterios, métricas, recursos, riesgos, responsable, fecha).
LabCandidate (referencias, por qué aplica, dependencia y complejidad).
LabSOW (entregable, inclusión/exclusión, presupuesto, tiempo, R0/R1/R2, propiedad intelectual, soporte, hosting y aceptación).
Artifact + TestPlan + TestRun/Evidence + DecisionPackage.
Usar Step 0–4 como funciones, no crear otro Core en Lab. No canonicalizar proposiciones de IA antes de revisión humana.
6. Inventario de realidad del Lab bancario: NO VERIFICADO
El usuario informa un Lab ad hoc operativo en cliente bancario. Los materiales locales y búsquedas accesibles de GitHub/Drive no identificaron un repositorio, ejecución, arquitectura y pruebas atribuibles inequívocamente a ese Lab. Por tanto no afirmamos stack, autonomía, módulos, flujos, seguridad, reutilización o readiness de producto.

Ítem    Evidencia obligatoria    Estado actual
Repositorio/commit/versiones    URL, SHA, rama, owner de código    NO EVIDENCIADO
Cliente/contrato/permisos IP    Contrato o acta de derechos de reutilización    NO EVIDENCIADO
Job bancario/alcance    SOW/PRD, casos de uso y exclusiones    NO EVIDENCIADO
Flujo de input/brief    UX, API, schema, prueba    NO EVIDENCIADO
Agentes/prompts/modelos    código y manifiesto de modelos/prompts    NO EVIDENCIADO
Construcción/generación    muestras y ejecución reproducible    NO EVIDENCIADO
QA, pruebas reales e iteraciones    test runs, defect log, trazas    NO EVIDENCIADO
Integraciones y credenciales    diagrama seguro sin secretos    NO EVIDENCIADO
Infraestructura y tenants    arquitectura y pruebas de aislamiento    NO EVIDENCIADO
Operación, coste por caso, soporte    logs anonimizados, costes y horas humanas    NO EVIDENCIADO
Uso de datos bancarios    políticas, autorizaciones, retención, DPA    NO EVIDENCIADO
Artefactos transferibles    muestra anonimizadas, licencias y handoff    NO EVIDENCIADO
Clasificación requerida por ingeniero
Cada componente: REUSE-AS-IS / EXTRACT-AND-GENERALIZE / BANK-SPECIFIC / REBUILD / NOT-READY. En cada fila: commit+ruta, propósito, entradas/salidas, datos, intervención humana, coste, seguridad, test reproducible, dependencia y derecho de reutilización. No copiar lógica, datos o prompts confidenciales del banco sin autorización escrita.

7. Automatización versus personas
Automatizable en un caso acotado: extracción de contexto no sensible; estructuración de brief; investigación con fuentes; propuestas técnicas; scaffolding/código; CI/tests técnicos; sintetizar resultados registrados; sugerir iteraciones. Humano por diseño: confirmar objetivo y restricciones, autorizar coste y acceso, decidir contratación, validar requisitos y aceptación, garantizar usuarios de prueba, revisar impacto/riesgo, aprobar deploy e integraciones, decidir continuar/pivotar y atribución de impacto. Ambos: diseño del experimento, revisión QA, interpretación de señales y priorización de cambios. Cada handoff debe tener responsable, evidencias y estado.

8. Security gates
Para demo: datos sintéticos y ambientes aislados. Para piloto real: aislamiento entre clientes, autorización server-side, secreto/credencial fuera de prompts/logs, consentimiento y gobernanza de datos, capacidad de revocación, auditoría, revisión de proveedores y accesos, backup/borrado/retención. Datos financieros o bancarios sensibles requieren revisión contractual y de seguridad específica. No afirmar S1/S2 certificado hasta haberlo probado.

9. Plan de productización de Lab
L0: inventario técnico/contractual del Lab existente y demos reproducibles; sólo auditoría, sin migrar.
L1: extraer pipeline reusable de un caso no sensible y delimitar casos elegibles.
L2: ofertar un paquete Essential pagado, operado por humano con IA; registrar horas/coste/iteraciones.
L3: repetir en >=2 casos diferentes con alto reuso y calidad; evaluar Build.
L4: soportar Extended sólo después de comprobar seguridad, soporte, costes recurrentes y ownership.
10. Benchmarks y criterios P0
Entrevistar 5–8 clientes; mostrar Decision Brief y comparar con alternativas reales (proveedor/consultor/LLM + hojas). Buscar al menos un compromiso económico verificable. Medir tiempo y coste para llegar a evidencia, calidad de decisión, esfuerzo humano, margen, defectos, % componentes reusados y satisfacción, sin prometer 2x/10x antes de medir. La validación bancaria ad hoc, incluso confirmada, no demostraría automáticamente encaje de mercado para pymes.

11. Decisiones pendientes obligatorias
Quién es dueño del IP y qué se puede reutilizar del Lab bancario.
Quién está autorizado a desplegar o tocar datos de clientes.
Definición de aceptación por tier y límite de horas de R1/R2.
Base tecnológica y estrategia de aislamiento.
Quién mantiene productos entregados y por cuánto tiempo.
Tarifas y alcance cerrado según costes observados.
Cómo debe interoperar el Decision Brief con el Core sin alterar contratos superiores.
