# DOC-101: DecisionBrief

**Código:** DOC-101  
**Versión:** 1.0  
**Fase:** F0 — Startería Decision  
**Emisor:** Product Lead (Startería)  
**Receptores:** Decisor del Cliente / Solution Architect (Startería Lab)  
**Estado del documento:** `[ ] DRAFT  |  [ ] REVIEWED  |  [ ] CLIENT_APPROVED`

---

## 1. Información General y Decisor

- **Empresa / Organización:** `[Nombre de la empresa]`
- **Sector / Industria:** `[Ej. Logística B2B, Retail, Fintech]`
- **Decisor Autorizado:** `[Nombre y Cargo del decisor con autoridad de presupuesto]`
- **Fecha de Elaboración:** `[YYYY-MM-DD]`
- **Versión del Brief:** `v1.0`

---

## 2. Enmarcado del Problema y Meta Deseada

### 2.1 Situación Actual y Cuello de Botella
> Describir objetivamente la situación operativa o comercial actual, sin inferir causalidades no probadas.

`[Texto detallado: qué proceso falla, dónde se pierde tiempo o dinero, y cómo se gestiona hoy]`

### 2.2 Meta Observable / Criterio de Éxito
> ¿Qué resultado concreto y medible definirá que este esfuerzo tuvo éxito?

- **Métrica o señal objetivo:** `[Ej. Reducir tiempo de conciliación de 4 horas a 15 minutos]`
- **Línea base (Baseline actual):** `[Dato medido o "Ausencia explícita de baseline"]`
- **Meta cuantitativa / cualitativa:** `[Meta acordada con el cliente]`

### 2.3 Intentos Previos y Alternativas Actuales
- **Intentos pasados:** `[Qué herramientas o consultores se probaron antes y por qué no funcionaron]`
- **Solución manual actual:** `[Ej. Hojas de cálculo compartidas, correos manuales]`

---

## 3. Restricciones, Capacidades y Gobernanza

- **Disponibilidad del equipo del cliente:** `[Ej. 2 horas semanales del Jefe de Operaciones]`
- **Plazo máximo para ver resultados:** `[Ej. 3 semanas]`
- **Presupuesto máximo a explorar:** `[Rango en moneda local / USD]`
- **Restricciones de datos / confidencialidad:** `[Prohibido uso de datos de clientes reales / Exclusivamente datos sintéticos]`
- **Fuentes de información consultadas:** `[Entrevistas realizadas, documentos revisados]`

---

## 4. Comparativa de Rutas de Ejecución (A / B / C)

| Dimensión | Ruta A: Por su cuenta | Ruta B: Startería Guided | Ruta C: Startería Lab (Recomendada) |
| :--- | :--- | :--- | :--- |
| **Enfoque** | Cliente ejecuta con recursos propios o proveedor externo. | Startería guía con copilot y Core Step 0–4 sobre equipo del cliente. | Startería Lab investiga y construye la solución técnica acotada. |
| **Nivel de Intervención** | Asesoría diagnóstica mínima. | Acompañamiento metodológico continuo. | Construcción delegada con ingenieros y fábrica de software. |
| **Entregables** | `ActionBrief` exportable con secuencia y riesgos. | Iniciativa estructurada, evidencias y `DecisionPackage`. | Prototipo/app funcional probada en staging + informe de decisión. |
| **Rango de Coste** | `[Bajo / Horas internas cliente]` | `[Medio / Cuota plataforma]` | `[Paquete SOW acordado: Essential / Build]` |
| **Ventana de Tiempo** | `[A ritmo del cliente]` | `[4–8 semanas]` | `[2–3 semanas (V0 + R1)]` |
| **Riesgos Principales** | Falta de foco y abandono interno. | Capacidad técnica insuficiente del cliente. | Desalineamiento si el cliente no aporta usuarios de prueba. |

---

## 5. Recomendación y Supuestos Clave

### 5.1 Justificación de la Ruta Recomendada
`[Explicación de por qué la Modalidad C (Lab) es la más razonable para el problema planteado]`

### 5.2 Supuestos que cambiarían esta preferencia
- Si el cliente cuenta con un equipo de desarrollo disponible de inmediato ➔ Cambiar a Ruta A.
- Si no existen usuarios reales dispuestos a probar el prototipo ➔ Suspender construcción técnica.

---

## 6. Próximo Paso y Aprobación

- **Decisión del cliente:**  
  `[ ] Acepta Ruta C (Startería Lab)`  
  `[ ] Acepta Ruta B (Guided)`  
  `[ ] Acepta Ruta A (Por su cuenta)`  
  `[ ] No contratar ninguna ruta`

- **Firma / Confirmación del Decisor:**  
  Nombre: `___________________________`  
  Fecha: `YYYY-MM-DD`  
  *Nota: Este brief representa un acuerdo de entendimiento y no constituye un contrato de obra hasta la firma del SOW.*
