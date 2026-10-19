# Integración Técnica: Startería Lab & sw-factory

Este directorio contiene el paquete completo de documentación técnica, aclaraciones arquitectónicas, taxonomía de interfaces y plantillas operativas para la integración de la fábrica de software (`sw-factory`) como motor de construcción dentro de la **Modalidad C (Startería Lab)** de Startería.

---

## Índice de Documentos

### 1. Informe Técnico Principal
- 📄 [**ACLARACIONES-fabrica-para-starteria.md**](./ACLARACIONES-fabrica-para-starteria.md)  
  Documento detallado dirigido al Product Lead y Engineering Lead de Startería.
  - **Qué es y qué no es la fábrica:** Fronteras de entrada (repositorio Git existente + señales técnicas; no briefs de negocio), salidas (ramas `fab/<id>`, commits, specs, tests), y gates de aprobación humana.
  - **Tabla de afirmaciones vs. realidad:** Contraste línea por línea con el código fuente y evidencias empíricas (desmitificación de scouting, validación de usuarios, deploy/hosting y supuesto contexto bancario).
  - **Encaje en el Flujo C (Lab):** Diagrama de secuencia y matriz de responsabilidades (Startería ➔ Humano del Lab ➔ Fábrica).
  - **Respuestas al Inventario NO VERIFICADO y Decisiones Pendientes.**
  - **Riesgos y límites medidos en P1:** Resultados reales (3/3 en modelos comerciales y Qwen local; 0/7 en LFM2.5 2.6B).
  - **5 Preguntas clave para iniciar la colaboración.**

### 2. Taxonomía de Interfaces y Gobernanza
- 📄 [**TAXONOMIA-DOCUMENTAL-STARTERIA-LAB.md**](./TAXONOMIA-DOCUMENTAL-STARTERIA-LAB.md)  
  Estandarización de los 5 niveles documentales que participan en el ciclo de vida de un encargo de Lab:
  - **Nivel 1:** Negocio, Diagnóstico y Contratación (Startería ➔ Humano del Lab).
  - **Nivel 2:** Arquitectura, Scouting y Preparación (Humano del Lab).
  - **Nivel 3:** Entrada a la Fábrica (Humano del Lab ➔ `sw-factory`).
  - **Nivel 4:** Salida y Verificación (`sw-factory` ➔ Humano del Lab).
  - **Nivel 5:** Transferencia, Prueba Real e Iteración (Humano del Lab ➔ Startería / Cliente).
  - Matriz de trazabilidad integral y las 4 Reglas de Oro de seguridad y datos.

### 3. Plantillas Operativas (Templates)
- 📁 [**templates/**](./templates/README.md)  
  Colección de 16 plantillas estandarizadas en Markdown y esquemas JSON listos para su uso en proyectos reales:
  - [`DOC-101-DecisionBrief.md`](./templates/DOC-101-DecisionBrief.md): Diagnóstico, meta, baseline y comparativa A/B/C.
  - [`DOC-102-ExecutionChoice.md`](./templates/DOC-102-ExecutionChoice.md): Autorización formal de Modalidad C (Lab).
  - [`DOC-103-LabSOW.md`](./templates/DOC-103-LabSOW.md): Statement of Work (Essential/Build/Extended, tope horas R1/R2, IP).
  - [`DOC-201-SolutionScoutingReport.md`](./templates/DOC-201-SolutionScoutingReport.md): Evaluación comparativa de 1 a 3 soluciones técnicas.
  - [`DOC-202-RepositoryManifest.md`](./templates/DOC-202-RepositoryManifest.md): Scaffolding de repositorio Git base y harness de pruebas.
  - [`DOC-203-SyntheticDataSpec.md`](./templates/DOC-203-SyntheticDataSpec.md): Fixtures sintéticos, mocks y política airgap (sin PII ni datos bancarios).
  - [`DOC-301-WorkstreamDefinition.md`](./templates/DOC-301-WorkstreamDefinition.md): Parámetros CLI de `fab ws create` y gates.
  - [`DOC-302-TechnicalSignal.md`](./templates/DOC-302-TechnicalSignal.md): Formato de payload técnico para `fab signal add`.
  - [`DOC-303-VerificationContract.json`](./templates/DOC-303-VerificationContract.json) & [Guía](./templates/DOC-303-VerificationContract.md): Misiones con `verificationCommands` y `protectedPaths`.
  - [`DOC-401-InvestigationSpec.md`](./templates/DOC-401-InvestigationSpec.md): Formato del `spec.md` en solo lectura para Gate 2.
  - [`DOC-403-ObjectiveVerificationReport.md`](./templates/DOC-403-ObjectiveVerificationReport.md): Auditoría de tests independientes y hashes de integridad.
  - [`DOC-404-ActivityMetricsReceipt.md`](./templates/DOC-404-ActivityMetricsReceipt.md): Recibo métrico de cómputo, turnos y tokens para costeo.
  - [`DOC-501-StagingHandoff.md`](./templates/DOC-501-StagingHandoff.md): Hoja de entrega de staging, credenciales y guía de prueba.
  - [`DOC-502-RealUserFeedbackLog.md`](./templates/DOC-502-RealUserFeedbackLog.md): Bitácora de feedback para clasificar R1/R2 vs. cambio de alcance.
  - [`DOC-503-FinalDecisionPackage.md`](./templates/DOC-503-FinalDecisionPackage.md): Paquete de cierre, repo transferible y recomendación final.

### 4. Materiales de Referencia Analizados
- 📁 [**reference/**](./reference/)  
  Documentación original suministrada por el equipo de Startería:
  - `01-decision-lab-spec-v0.1.md`: Product Spec de trabajo v0.1 de Startería Decision + Lab.
  - `02-master-plan-v1.2.md`: Master Plan de producto y convergencia v1.2.
  - `03-e2e-01-10-y-adversariales-anterior.md`: Especificación E2E y matriz de escenarios adversariales.
