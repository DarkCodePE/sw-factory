# Catálogo de Plantillas Documentales: Startería Lab & sw-factory

Este directorio contiene las plantillas estandarizadas en Markdown y esquemas JSON correspondientes a la [Taxonomía Documental de Startería Lab](../TAXONOMIA-DOCUMENTAL-STARTERIA-LAB.md).

---

## Índice de Plantillas Disponibles

### Nivel 1: Negocio, Diagnóstico y Contratación (Startería ➔ Humano del Lab)
- [`DOC-101-DecisionBrief.md`](DOC-101-DecisionBrief.md): Diagnóstico inicial, problema, alternativas A/B/C y recomendación.
- [`DOC-102-ExecutionChoice.md`](DOC-102-ExecutionChoice.md): Elección formal y autorización de la Modalidad C (Lab).
- [`DOC-103-LabSOW.md`](DOC-103-LabSOW.md): Contrato SOW para paquetes Essential/Build/Extended, tope de horas R1/R2 y cláusulas IP.

### Nivel 2: Arquitectura, Scouting y Preparación (Humano del Lab)
- [`DOC-201-SolutionScoutingReport.md`](DOC-201-SolutionScoutingReport.md): Comparativa técnica de 1 a 3 soluciones y selección de stack.
- [`DOC-202-RepositoryManifest.md`](DOC-202-RepositoryManifest.md): Scaffolding del repo Git base, dependencias y comandos de test requeridos.
- [`DOC-203-SyntheticDataSpec.md`](DOC-203-SyntheticDataSpec.md): Fixtures sintéticos, mocks de APIs y política de cero datos reales (airgap).

### Nivel 3: Interfaz de Entrada a la Fábrica (Humano del Lab ➔ `sw-factory`)
- [`DOC-301-WorkstreamDefinition.md`](DOC-301-WorkstreamDefinition.md): Parámetros CLI de `fab ws create`, concurrency y gates obligatorios.
- [`DOC-302-TechnicalSignal.md`](DOC-302-TechnicalSignal.md): Formato de payload técnico para `fab signal add` y `fab triage`.
- [`DOC-303-VerificationContract.json`](DOC-303-VerificationContract.json): Esquema JSON de misiones con `verificationCommands` y `protectedPaths`.
- [`DOC-303-VerificationContract.md`](DOC-303-VerificationContract.md): Guía de seguridad y ejecución del contrato de misiones.

### Nivel 4: Salida y Verificación (`sw-factory` ➔ Humano del Lab)
- [`DOC-401-InvestigationSpec.md`](DOC-401-InvestigationSpec.md): Plantilla del `spec.md` producido en solo lectura para revisión en Gate 2.
- [`DOC-403-ObjectiveVerificationReport.md`](DOC-403-ObjectiveVerificationReport.md): Reporte de verificación del runner con salida de tests y hashes de integridad.
- [`DOC-404-ActivityMetricsReceipt.md`](DOC-404-ActivityMetricsReceipt.md): Recibo métrico con segundos de cómputo, turnos y tokens para costeo.

### Nivel 5: Transferencia, Prueba Real e Iteración (Humano del Lab ➔ Startería / Cliente)
- [`DOC-501-StagingHandoff.md`](DOC-501-StagingHandoff.md): Hoja de entrega de staging, credenciales y guía de prueba para el cliente.
- [`DOC-502-RealUserFeedbackLog.md`](DOC-502-RealUserFeedbackLog.md): Bitácora de hallazgos y matriz de clasificación para R1/R2 vs. cambio de alcance.
- [`DOC-503-FinalDecisionPackage.md`](DOC-503-FinalDecisionPackage.md): Paquete final de entrega, repo transferible y recomendación de decisión.
