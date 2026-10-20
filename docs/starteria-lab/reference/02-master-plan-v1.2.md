# STARTERÍA — Master Plan de producto y convergencia v1.2

**Fecha:** 18 de octubre de 2026  
**Estado:** Propuesta para aprobación de producto y verificación técnica. NO contrato Core aprobado, no instrucción de merge/deploy, no certificación de producto.  
**Reemplaza en alcance de producto:** `STARTERIA_MVP_MASTER_PLAN_v1.1.md` y, para el objetivo E2E, `STARTERIA_MVP_PLAN_DE_CONVERGENCIA_v1.0.md`.  
**Especificaciones compañeras:** `STARTERIA_E2E_OBJETIVO_UNIFICADO_v0.1.md`, `STARTERIA_DECISION_LAB_PRODUCT_SPEC_v0.2.md`.  
**Autoridad superior intacta:** `STARTERIA_AUTHORITY.md`, Core vigente, ADRs aprobados, Experience/Agent/Skill Contracts aplicables. `STARTERIA_CORE_LOGIC_CONTRACT.md` aportado está rotulado **v0.3 candidata / requiere retest**; no se da por aprobado automáticamente.

## 0. Decisión ejecutiva y cambio desde v1.1

Startería valida la capacidad de convertir **una necesidad empresarial en una decisión defendible y, opcionalmente, en un ciclo de ejecución comprobable**, no la instalación de una plataforma corporativa completa antes de la primera venta.

**Nuevo orden de interacción:**

```text
Cliente explica necesidad en lenguaje natural
  → Startería Decision (primera reunión asistida en P0)
  → Decision Brief con interpretación, evidencia disponible, incertidumbres,
    recomendación y comparativa de MODALIDADES A/B/C
  → elección humana o ninguna
      A. Por cuenta propia / proveedor → Action Brief (fuera de ejecución Startería)
      B. Startería Platform → elegir UNIDAD DE GESTIÓN:
           B1. UNA INICIATIVA → Entry/Overview/Steps 0–4 → Decision Package
           B2. UN PORTAFOLIO → Portfolio Lead → frentes/retos/iniciativas
                 → asignación → mismo Steps 0–4 → retorno al portafolio
      C. Startería Lab → 1–3 soluciones técnicas viables, SOW y paquete elegido
                 → sw-factory como motor técnico candidato + equipo humano
                 → pruebas → hasta 2 iteraciones delimitadas → entrega y decisión
```

**Diferencia de versiones:** v1.1 exponía A-Pyme y B-Portfolio como **dos entradas principales**. v1.2 propone **Decision como entrada comercial común**; la elección de **una iniciativa vs portafolio ocurre sólo dentro de Platform**. No crear un segundo Core, no duplicar el onboarding que ya existe; reutilizar la revisión inicial y Portfolio Entry como componentes/handoffs posteriores a la decisión.

**Diferencia de calendario:** el P0 prioritario pasa a ser **validación comercial y de valor en ~2 semanas**, sin exigir que toda la plataforma esté terminada. La auditoría técnica de entrada se limita a validar qué se puede demo/pilotear con seguridad y a registrar blockers. Las fechas de la planificación técnica anterior de cuatro-cinco meses **no son compromisos vigentes de este P0**. Los tiempos de implementación completos se recalculan después de vender/contrastar un caso y comprobar los repositorios por SHA.

## 1. Propuesta de valor y JTBD

**Tesis común:** «Dime qué quieres conseguir, qué puedes invertir y qué sabes de tu situación; Startería te ayuda a comparar cómo hacerlo y a convertir la ruta elegida en trabajo y evidencia para decidir». La IA no garantiza valor económico, demanda ni ejecución organizacional. Cada alternativa debe poder recomendarse o descartarse por criterios objetivos aunque el cliente no contrate Lab ni Platform.

| Comprador / Job | Primer resultado que debe obtener | Riesgo que reducen las decisiones |
|---|---|---|
| Pyme B2B con oportunidad de crecimiento | Decision Brief y una prueba de bajo riesgo, por sí mismo/Guided/Lab | Invertir en la solución incorrecta sin evidencia |
| Líder de área con una iniciativa y uno o varios equipos | Iniciativa aclarada, owner, contexto y Core con decisión | Pérdida de foco/contexto y bloqueos |
| Portfolio Lead corporativo con varias apuestas | Frente/reto(s), Contribution Map, owners, evidencia, decisiones | Esfuerzos dispersos sin claridad sobre contribución |
| Cliente que delega una herramienta digital | Execution Brief, artefacto técnicamente comprobado, QA y feedback | Tener que montar equipo de desarrollo antes de probar |

## 2. Scope P0 y fronteras de comercialización

**P0 — objetivo comercial de 10–14 días, no SaaS universal:** ejecutar 5–8 conversaciones con decisores pyme B2B, co-crear 1–2 Decision Briefs reales sobre datos permitidos, probar comprensión de A/B/C y B1/B2, mostrar ejemplos de outputs y buscar al menos un compromiso económico verificable (pago, anticipo o acuerdo concreto con precio/alcance). El acceso a datos sensibles en Startería productiva sigue prohibido hasta superar gates de seguridad. Si aparece una empresa con portafolio, también puede probarse el brief empresarial, sin condicionar P0 a implementar todo su workspace.

**Prueba de la propuesta comercial** no implica que el software de Platform esté ya operativo. En P0 el diagnóstico y estimaciones pueden hacerse asistidamente con el founder; distinguir minutos de IA, horas de consultoría y esfuerzo del cliente.

**MVP técnico incremental, condicionado a demanda:** 1) resolver seguridad/identidad; 2) B1 una iniciativa sobre Core ya construido; 3) B2 portafolio con ese mismo Core; 4) Lab Essential solo si `sw-factory` supera verificación técnica y existe un alcance vendible. No prometer fecha de producto completo sin backlog reconciliado.

**Fuera ahora:** engine autónomo universal de scouting/build/QA/validación de mercado, self-provisioning empresarial no autorizado, SSO, marketplace, habilidades/gamificación, dashboards avanzados, beneficio L5/L6 automatizado, integraciones profundas, múltiples niveles de decisión por comité y seguimiento del Lab Extended universal.

## 3. El E2E objetivo, referencia normativa de producto (no Core)

**Fuente detallada:** `STARTERIA_E2E_OBJETIVO_UNIFICADO_v0.1.md`. Se aplica a UX, outputs, handoffs, QA y planeación, en tanto no contradiga autoridad superior. Cualquier conflicto se registra y se decide, no se implementa silenciosamente.

### F0 — Decision (común)

- Pre-Core: reunión → estructuración → brief revisable y comparativa A/B/C, costes/plazos en **rangos condicionados**, con fuentes y gaps.
- Acción principal: elegir ruta, solicitar más información o no contratar.
- Output: `DecisionBrief (revisionado)` y elección provisional. Nunca crear Organization/StrategicFront/Challenge/Initiative automáticamente al generar interpretación.

### F1A — Propia cuenta

- Exportar `ActionBrief`: recursos, secuencia viable, presupuesto preliminar, riesgos, dependencias y responsable.
- No fabricar proyecto ni estado de ejecución en el SaaS. Check-in opcional si el cliente acepta.

### F1B — Platform: seleccionar alcance

- En una interacción corta preguntar: **«¿Quieres desarrollar una iniciativa o gestionar un portafolio de iniciativas?»**
- Explicar diferencias prácticas sin taxonomía técnica: una apuesta, una decisión y un owner (colaboradores posibles) vs varios esfuerzos, posibles frentes/retos, responsables y decisiones agregadas.
- El Copilot recomienda B1/B2 **como propuesta** según job, no únicamente cantidad de equipos.

**B1 (Una iniciativa)**: revisión inicial de la iniciativa conectada al brief → usuario confirma alcance → `Initiative Draft` autorizado e idempotente → Overview → Start → Core Step 0–4 → evidencia/Decision Package → decisión humana. Una iniciativa puede tener varios colaboradores/equipos sin transformarse en un portafolio. Independiente no hereda un reto corporativo ficticio; corporativa mantiene su vinculación y permisos según Core.

**B2 (Portafolio)**: Front/Challenge Setup desde el brief precargado → Copilot propone frente y retos alineados → usuario corporativo autorizado confirma → puede crear varios frentes pero **no debe hacerlo por obligación** → importar/vincular/crear iniciativas → mapear contribución/cobertura/posible solapamiento con confirmación → invitar/asignar owners → aceptación separada de Start → Core B1 por cada iniciativa que avanza → retorno al frente/reto/Home. Copilot puede sugerir «otros frentes posibles» como backlog sujeto a revisión, nunca crearlos por inferencia.

### F1C — Lab

- Debe existir **Lab Eligibility**: confirmar que encargo digital, clientes de prueba, presupuesto, riesgos y derechos son abordables.
- Comparar **hasta** 1–3 soluciones técnicas razonables; no confundir alternativas técnicas con tres modalidades de ejecución.
- Aprobar SOW/ExecutionBrief del nivel Essential/Build/Extended → investigar/construir mediante herramientas, incluyendo `sw-factory` como motor de cambios de software candidato → QA → usuarios reales si accesibles → hasta R1 y R2 acotadas → entrega, evidencia, decisión.
- Lab puede ser **servicio humano asistido** y no se condiciona su primera venta a desarrollar una UI multiempresa.

## 4. Outputs y definición de calidad

| Output | Requisito verificable | Qué NO significa |
|---|---|---|
| `DecisionBrief` | estado actual, meta o señal, fuentes, riesgos, opciones A/B/C, bandas coste/tiempo/capacidad, recomendación provisional, decisión pendiente | análisis completo de causalidad, presupuesto garantizado |
| `ActionBrief` | próximo movimiento realizable, recursos propios/proveedor, dependencias y criterios para revisar | servicio de implementación aceptado |
| `InitiativeBrief` / Overview | contexto heredado, qué se sabe/queda abierto, owner, decisión/ciclo/Steps | promesa de éxito o sponsor automáticamente aprobado |
| `Strategic/Challenge Brief` | frente/reto(s) confirmados, KPI/señal y horizonte cuando existen, enlaces y restricciones | que todo objetivo propuesto sea canónico |
| `Contribution Map` | iniciativas, relación propuesta/confirmada, fuente y gaps; cobertura contextual | % de impacto atribuido, duplicidad definitiva |
| `Step outputs` | 0: enmarcar; 1: sustentar; 2: preparar entregable ejecutable; 3: ejecutar/observar; 4: paquete de decisión | checklists rígidos universales o evidencia inventada |
| `Lab Candidate + SOW + Artifact` | por qué propuesta encaja, esfuerzo, dependencia, QA, máximo R1/R2, criterios/IP/soporte | mercado validado por tests técnicos |
| `Decision Package` | qué pasó, con qué evidencia, límites, recomendación y humano decisor | ejecución automática de inversión/escala |

## 5. Qué se conserva / adapta / añade / posterga

| Área | Tratamiento | Comentario para el ingeniero |
|---|---|---|
| Autenticación, grants y entidades corporativas | **REUSE + VERIFY SECURITY** | No nuevos permisos automáticos por botón; verificar cross-tenant/revoke en SHA real |
| `STARTERIA_CORE_LOGIC_CONTRACT` + Adaptive Core Step 0–4 | **PRESERVE FUNCTIONS** | No reabrir semántica estable para hacer funcionar la UI de selección |
| Portfolio Entry + extracción, reverse alignment, Clarification/Handoff | **REUSE/ADAPT** | Ahora pueden alimentarse desde Decision Brief; evitar preguntas duplicadas |
| Initial Review + Overview de Initiative Owner | **REUSE/ADAPT** | B1, una iniciativa; conservar confirmación explícita y versión de fuente |
| Portfolio Lead, Strategic Framing, Home | **REUSE/ADAPT** | B2, contexto del brief + multi-frente existente; no reconstruir dashboards |
| Imports y asociación a retos | **ADAPT** | 6–12 iniciativas en primer test, evidencia importada y revisión humana |
| Assignment / Claim / Start | **ADAPT + FIX** | email real, roles y idempotencia; aceptación no debe ser Start ni doble creación |
| Evidence / claims / Decision Package | **REUSE + VERIFY** | no promover afirmaciones o actividad a resultados sin fuente |
| Decision Brief pre-Core A/B/C | **NEW de alcance mínimo** | P0 puede ser artefacto manual; no obligar UI nuevo inmediata |
| Selector B1/B2 e handoff revisionado | **NEW UX + ADAPTER** | pequeño delta de routing, no producto paralelo |
| sw-factory como motor de desarrollo | **REUSE SUBJECT TO L0** | repo `DarkCodePE/sw-factory@c3eff63`, sin evidencia de operación bancaria end-to-end |
| Lab comercial y validación de usuarios | **SERVICE-FIRST/ADAPT** | pricing/SOW, revisión humana y R1/R2 no están probados como producto autónomo |
| Gestión de beneficios avanzada, MCP productivo, SSO, marketplace | **DEFER** | mantener backlog, no borrar componentes por estar fuera de P0 |

## 6. Reglas de autoridad, seguridad y datos

1. **Pre-Core:** Interpretation / DecisionBrief es provisional; la IA no crea StrategicFront/Challenge/Initiative/Step/Evidence canónica, no aprueba KPI ni decisiones humanas.
2. **Selección de modalidad no otorga rol:** organización, Portfolio Lead, initiative owner y asistentes requieren identidad y permisos legítimos. Las iniciativas independientes requieren conciliación con Core/ADRs aprobados.
3. **Origen y revisión separados:** USER_DECLARED / EXTRACTED / AI_INFERRED / AI_SUGGESTED y UNREVIEWED / USER_CONFIRMED / etc. Fuente material rastreable.
4. **Sin side effects a partir de texto:** registrar versiones; sólo acciones explícitas y autorizadas crean objetos o inician fábricas.
5. **Seguridad real:** datos ficticios/sintéticos para demo; datos de cliente reales no sensibles y minimizados únicamente cuando autorización, tenants, sesiones, permisos, revocación, gestión de proveedor IA y retención hayan superado gate técnico S1; información bancaria/sensible requiere revisión contractual adicional.
6. **Lab:** SOW firmado no sustituye gate de seguridad; ejecución en sandbox obligatorio aislado, credenciales no expuestas a modelos; aprobación humana de cambios críticos y despliegue.
7. **No prometer:** impacto 2x, ingreso, PMF, ROI, beneficio atribuido, validación externa ni dos iteraciones «automáticas» sin evidencia.

## 7. Qué medimos: negocio, producto y tecnología

**P0 comercial:** número de entrevistas cualificadas, problemas y alternativas reales, briefs entendidos, intención de pago, compromisos económicos, coste del diagnóstico y de operación asistida. No validar demanda mediante sólo clics en prototipo.

**Valor de Platform:** tiempo/coste de obtener decisión de calidad comparable, % iniciativas con evidencia utilizable, traspaso de contexto, tareas con 2x mejora sin caída de calidad, incremento de decisiones sustentadas por capacidad, problemas reales de coordinación. Un 2x en tiempo no reemplaza impacto de negocio.

**Valor de Lab:** coste total hasta una primera evidencia externa, tiempo técnico de prototipo, horas humanas, margen, éxito técnico y funcional, R1/R2 completadas dentro de alcance y qué porcentaje se reutiliza entre clientes. No confundir tests automatizados con validación de usuarios.

## 8. Fases y seguimiento vigentes (no cronograma de 5 meses)

| Gate | Trabajos mínimos | Salida requerida | Estado inicial |
|---|---|---|---|
| **P0 Comercial** | 5–8 entrevistas / muestra de brief / oferta A/B/C / explorar venta; ingeniería verifica seguridad mínima de demos | Decidir si la oportunidad y el mecanismo merecen inversión | PROPUESTO |
| **D1 Diseño** | outputs ejemplo + wireflow E2E A/B/C + UX test, reusando Figma previo | comprensión del cliente y navegación B1/B2 | PENDIENTE |
| **T0 Reconciliación técnica** | SHA plataforma, ADR/roles y Lab@SHA; matriz REUSE/ADAPT/NEW/DEFER | alcance ejecutable de una vertical | POR VERIFICAR |
| **T1 B1 funcional** | entrada autorizada, Overview, Core, evidencia, cierre, error recovery | `B1_E2E_ACCEPTED` | POR VERIFICAR |
| **T2 B2 funcional** | Portfolio Lead, import, contribución, email, mismo Core, retorno | `B2_E2E_ACCEPTED` | POR VERIFICAR |
| **L0-L2 Lab** | smoke real/seguridad sw-factory; adaptador mínimo; primer Essential asistido y pagado | artefacto verificable + coste/margen y test cliente | POR VERIFICAR |
| **V Comercial** | Comparador real vs baseline (manual y LLM+docs), cohortes adicionales | GO/ITERAR/NO-GO documentado | PENDIENTE |

**Criterio de progreso:** no sumar `PRs` como MVP. Registrar gate aprobado, transiciones E2E que funcionan y evidencia: SHA, tests, capturas/escenarios, resultados, aceptación humana. No inventar fecha de entrega completa ni presupuestar cientos de horas sin resultado comercial de P0 y reconciliación técnica.

## 9. Responsable de cada decisión

- **Product Lead:** hipótesis de valor, segmento, claridad de A/B/C, decisión B1/B2, criterios de comparación, outputs y aceptación UX.
- **Engineering Lead:** Core/ADR compatible, repos y SHAs, seguridad, viabilidad de handoff, tests, idempotencia, releases y data retention.
- **Responsable Lab / técnico:** elegibilidad de soluciones, SOW técnico, estimación por caso, QA, trazabilidad de factory job, entregables y soporte.
- **Cliente/decisor autorizado:** alcance, presupuesto, fuentes, permiso de acceso, resultados, adopción y decisiones organizacionales.

## 10. Aceptación y prueba adversarial mínima

1. **DEC-01:** un usuario explica problema ambiguo; recibe Brief revisable que no inventa baseline y compara A/B/C. Puede no contratar; no se crean objetos canónicos.
2. **B1-01:** elige Platform→Una iniciativa, lleva una iniciativa (independiente) a Overview/Step 0–4/Decision Package; reintentos no duplican; owner correcto.
3. **B1-02:** una iniciativa con tres equipos sigue siendo B1; no se le fuerza un portafolio por colaboradores.
4. **B2-01:** elige Platform→Portafolio, confirma 1 frente y reto, importa 6–12 iniciativas, revisa Contribución, asigna, destinatario acepta, desarrolla una en Core y retorna resultado; IA puede sugerir otro frente sin crearlo.
5. **C-01:** Lab selecciona 1–3 soluciones, SOW, ejecuta un trabajo de software acotado, QA técnico independiente y test real cuando corresponda; R1/R2 no son retries internos.
6. **NEG-01:** click a B2 no otorga grant; intento de acceso cross-tenant falla; si se revoca acceso, contenido y reportes dejan de estar accesibles.
7. **NEG-02:** IA/trabajo no eleva hecho sin fuente, no atribuye beneficio, no afirma que tests técnicos validaron demanda.

`B1_E2E_ACCEPTED`, `B2_E2E_ACCEPTED` o `LAB_ACCEPTED` sólo con runtime reproducido; documentación, diseño, commit, captura aislada o PASS de harness determinista no bastan. Aceptación de valor de negocio se registra aparte.

## 11. Documentos y cambio de vigencia

| Documento | Estado desde este plan |
|---|---|
| `STARTERIA_E2E_OBJETIVO_UNIFICADO_v0.1.md` | **TARGET de experiencia referencial** para Product, UX, QA e Ingeniería, pendiente de aprobación |
| `STARTERIA_DECISION_LAB_PRODUCT_SPEC_v0.2.md` | Nueva especificación de modalidades y nivel Lab, pendiente de aprobación |
| `STARTERIA_MVP_MASTER_PLAN_v1.1.md` | Sustituido para alcance E2E por v1.2; archivo histórico |
| `STARTERIA_MVP_PLAN_DE_CONVERGENCIA_v1.0.md` y `STARTERIA_MVP_CONVERGENCE_CHARTER_v0.1.md` | Históricos. No definir alcance vigente desde sus diagramas |
| `STARTERIA_P0_TIMEBOX_Y_FECHAS_v1.2.md` | Histórico de P0 técnico; no usar su presupuesto o fechas como aprobación de P0 comercial |
| `STARTERIA_P0_FICHA_HIPOTESIS_PYME_B2B_v0.1.md` | Mantener para entrevistas; adaptar brief/oferta a modalidades A/B/C |
| `STARTERIA_SW_FACTORY_AUDITORIA_INICIAL_v0.1.md` | Evidencia de repositorio `sw-factory@c3eff63`, no prueba de Lab comercial listo |
| `STARTERIA_CORE_LOGIC_CONTRACT.md`, `STARTERIA_AUTHORITY.md`, ADRs, Agent/Skill contracts | **No se editan ahora**. Ante conflicto, elevar decisión de autoridad separada |

**Regla de entrega:** el primer valor es un Brief y una elección informada. La plataforma y el Lab ejecutan sólo la ruta autorizada, no un onboarding empresarial completo ni construcción autónoma por defecto. Cada ruta termina en evidencia y una decisión con un humano responsable.
