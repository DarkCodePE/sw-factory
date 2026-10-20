# DOC-401: InvestigationSpec (Plantilla de spec.md)

**Código:** DOC-401  
**Versión:** 1.0  
**Fase:** F1C — Salida de Investigación de `sw-factory` (Gate 2)  
**Emisor:** Worker de Investigación (Agente de IA en modo `spec` / solo lectura)  
**Receptor:** Inbox de Aprobación Humana (`fab inbox` / `fab tui`)  
**Change ID:** `[hash-del-change]` | **Rama Worktree:** `fab/[change-id-slice]`  
**Estado:** `STATUS: awaiting_review`

---

## STATUS: done
*(Nota del motor: Esta primera línea estricta es requerida por el parser de la fábrica para validar que la investigación concluyó exitosamente).*

---

## 1. Resumen de la Investigación
`[Explicación concisa del problema analizado por el agente en modo solo lectura]`

El agente inspeccionó los archivos relevantes del repositorio en el worktree aislado sin realizar ninguna modificación en el código fuente.

---

## 2. Archivos Inspeccionados y Diagnóstico

- `src/services/existing_module.ts`: Se detectó que la función `process()` no contempla valores nulos.
- `src/models/types.ts`: Los tipos actuales carecen de la interfaz necesaria para el reporte de discrepancias.
- `tests/services/reconciliation.test.ts`: Los tests unitarios actuales fallan porque la función aún no está exportada.

---

## 3. Plan de Implementación Propuesto

Para satisfacer los criterios de aceptación de la señal (`DOC-302`), se proponen los siguientes cambios:

### 3.1 Archivos a Crear
- `src/services/reconciliation.ts`: Implementación de la lógica del algoritmo de cruce.

### 3.2 Archivos a Modificar
- `src/index.ts`: Exportar la nueva función de conciliación.
- `src/models/types.ts`: Añadir la definición de `DiscrepancyReport`.

### 3.3 Nuevas Dependencias
- *Ninguna:* Se resolverá utilizando exclusivamente las dependencias existentes en `package.json`.

---

## 4. Estrategia de Validación y Pruebas

- **Comando de prueba a ejecutar:** `bun test tests/services/reconciliation.test.ts`
- **Comportamientos a verificar:**
  - Caso nominal con 100% de coincidencia.
  - Caso con discrepancia en el monto de factura.
  - Caso con factura faltante.
  - Tolerancia a listas vacías.

---

## 5. Decisiones Requeridas por el Revisor Humano (Gate 2)

El Ingeniero del Lab debe revisar esta propuesta en el Inbox y ejecutar:

```bash
# Opción A: Aprobar la propuesta y autorizar que el pool inicie la implementación
fab review <activityId> approve

# Opción B: Solicitar ajustes a la propuesta técnica indicando comentarios
fab review <activityId> comment "Asegurar que se utilice Math.round para evitar errores de coma flotante"

# Opción C: Rechazar la propuesta si el enfoque es incorrecto
fab review <activityId> decline
```
