# DOC-302: TechnicalSignal / ChangePayload

**Código:** DOC-302  
**Versión:** 1.0  
**Fase:** F1C — Entrada a Fábrica de Software  
**Emisor:** Solution Architect / Ingeniero del Lab  
**Receptor:** `sw-factory` (Tabla `signals` / `changes`)  
**Workstream:** `[slug-del-workstream]`  
**Referencia SOW:** `DOC-103` (Entregable número `[X]`)

---

## 1. Comando de Ingesta CLI

El Ingeniero del Lab inyecta la señal en la fábrica mediante el comando:

```bash
fab signal add <slug> "<TITULO_TECNICO>" --body "$(cat <<'EOF'
<CONTENIDO_DEL_BODY_ESTRUCTURADO>
EOF
)"

# Triage inmediato para convertir la señal en un change sujeto a revisión
fab triage --all <slug>
```

---

## 2. Estructura Estándar del Body de la Señal

### 2.1 Título de la Señal (Title)
> Conciso, en modo infinitivo, enfocado en una sola responsabilidad técnica.
`[Ej. Implementar servicio de cruce de pedidos con facturas y cálculo de diferencias]`

### 2.2 Contexto y Problema Técnico (Problem & Context)
`[Explicación de la necesidad dentro de la arquitectura del repositorio]`
- Módulos existentes relacionados: `[ej. src/models/order.ts, src/parsers/invoice.ts]`
- Ubicación esperada de la nueva lógica: `[ej. src/services/reconciliation.ts]`

### 2.3 Contrato de Entrada y Salida (API / Interface Contract)
Definición de tipos o firmas de funciones requeridas:
```typescript
export interface DiscrepancyReport {
  orderId: string;
  invoiceId: string;
  expectedAmount: number;
  actualAmount: number;
  difference: number;
  status: 'MATCH' | 'DISCREPANCY' | 'MISSING_INVOICE';
}

export function reconcileOrders(orders: Order[], invoices: Invoice[]): DiscrepancyReport[];
```

### 2.4 Criterios de Aceptación Objetivos (Acceptance Criteria)
1. La función debe tolerar listas vacías retornando un array vacío sin excepciones.
2. Si la diferencia absoluta es menor a `0.01`, el estado debe ser `'MATCH'`.
3. Si la factura no existe en el conjunto, el estado debe ser `'MISSING_INVOICE'`.
4. Todos los tests en `tests/services/reconciliation.test.ts` deben pasar.

### 2.5 Restricciones y Guías de Implementación
- No modificar esquemas de base de datos existentes.
- Utilizar librerías ya instaladas en `package.json` (no agregar nuevas dependencias externas sin justificación en el spec).
- Mantener la cobertura de tests sin modificar los archivos declarados como protegidos.

---

## 3. Ciclo de Vida tras la Ingesta

1. **Estado `triaged`:** Al ejecutar `fab triage`, se crea un registro en la tabla `changes` con estado `pending`.
2. **Revisión del Change (Gate 1):** El humano revisa en `fab inbox` o `fab tui` y aprueba el cambio (`fab review <changeId> approve`).
3. **Paso a Investigación:** El pool despacha un worker en modo `spec` (solo lectura) para redactar `DOC-401 (spec.md)`.
