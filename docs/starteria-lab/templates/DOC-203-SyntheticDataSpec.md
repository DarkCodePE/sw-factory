# DOC-203: SyntheticDataSpec & Mocks

**Código:** DOC-203  
**Versión:** 1.0  
**Fase:** F1C — Preparación Técnica del Lab  
**Emisor:** Solution Architect / Ingeniero del Lab  
**Receptores:** Repositorio Git (`fixtures/`) / Agentes de `sw-factory`  
**Iniciativa:** `[Nombre de la iniciativa]`

---

## 1. Declaración Obligatoria de Seguridad y Datos

> **POLÍTICA DE TOLERANCIA CERO A DATOS REALES (AIRGAP POLICY):**  
> Ningún archivo dentro del repositorio ni en las señales técnicas de la fábrica contendrá información personal identificable (PII), números de cuentas bancarias reales, tarjetas de crédito, contraseñas de clientes o secretos corporativos. Toda información utilizada para desarrollo y pruebas debe ser 100% sintética o mockeada.

---

## 2. Entidades de Datos Modeladas

| Entidad | Propósito en el Prototipo | Formato de Archivo | Ruta en el Repositorio |
| :--- | :--- | :--- | :--- |
| **Facturas / Comprobantes** | Muestras de documentos a procesar. | PDF sintético / JSON | `fixtures/invoices/sample_*.json` |
| **Catálogo de Productos** | Tabla de referencia de precios y SKUs. | CSV / SQLite seed | `fixtures/catalog.csv` |
| **Usuarios de Prueba** | Cuentas simuladas para login en staging. | SQL seed | `fixtures/seeds/users.sql` |
| **Respuestas de APIs Terceros**| Payloads simulados de webhooks/pagos. | JSON mock | `tests/mocks/webhook_payload.json` |

---

## 3. Esquemas de Datos de Prueba

### 3.1 Ejemplo de Esquema de Usuario / Operador Sintético
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SyntheticUser",
  "type": "object",
  "properties": {
    "id": { "type": "string", "example": "usr_test_001" },
    "name": { "type": "string", "example": "Operador de Pruebas Alpha" },
    "email": { "type": "string", "example": "tester-alpha@starteria-lab.invalid" },
    "role": { "type": "string", "enum": ["admin", "reviewer", "operator"] }
  },
  "required": ["id", "name", "email", "role"]
}
```

### 3.2 Ejemplo de Factura Sintética
- **RUT / Identificador fiscal:** `99.999.999-K` (RUT de prueba de fantasía).
- **Razón Social:** `Empresa de Pruebas Ficticia S.A.`
- **Montos:** Valores aleatorios enteros de prueba (ej. $10,000, $25,500).

---

## 4. Estrategia de Mocks para Integraciones Externas

Cuando la solución requiera consultar servicios de terceros (ej. pasarelas de pago, APIs de facturación electrónica o mensajería):

1. **Patrón Adapter / Interface:** El código implementará una interfaz abstracta (ej. `PaymentGatewayClient`).
2. **Implementación de Desarrollo:** La fábrica implementará y probará un cliente mock en memoria (`MockPaymentGatewayClient`) que responde de forma determinista basándose en los fixtures de `fixtures/`.
3. **Aislamiento de Red:** Recordar que el sandbox `bwrap` de la fábrica bloquea el acceso a internet por defecto (`--unshare-net`), por lo que cualquier llamada a internet real fallará inmediatamente. Los mocks son obligatorios para que los tests pasen.

---

## 5. Firma de Verificación de Privacidad

El Ingeniero del Lab certifica que los datos incluidos en el repositorio han sido revisados y saneados:

- `[X]` Certifico que no existen datos de producción ni información confidencial en los fixtures.  
**Ingeniero Responsable:** `[Nombre del Ingeniero]`  
**Fecha:** `[YYYY-MM-DD]`  
