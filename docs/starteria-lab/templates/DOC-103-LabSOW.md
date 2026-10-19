# DOC-103: LabSOW (Statement of Work)

**Código:** DOC-103  
**Versión:** 1.0  
**Fase:** F1C — Contratación de Startería Lab  
**Emisores:** Product Lead (Startería) & Solution Architect (Startería Lab)  
**Receptor:** Decisor del Cliente (para firma)  
**Estado:** `[ ] PROPUESTO  |  [ ] REVISADO  |  [ ] FIRMADO`

---

## 1. Partes y Antecedentes

- **Proveedor:** Startería Lab (Representado por: `[Nombre del Product Lead]`)
- **Cliente:** `[Razón Social del Cliente]` (Representado por: `[Nombre del Decisor]`)
- **Iniciativa:** `[Nombre del proyecto]`
- **Brief Base:** `DOC-101-[ID]-v1.0` | **Elección:** `DOC-102-[ID]`
- **Fecha de Emisión:** `[YYYY-MM-DD]`

---

## 2. Nivel de Paquete Contratado

Se contrata la modalidad técnica bajo el siguiente nivel de producto (marcar exactamente uno):

- `[ ] ESSENTIAL:` Demostración funcional / proxy / flujo crítico único. Construcción de baja complejidad. Validación técnica de supuestos.
- `[ ] BUILD:` Aplicación o automatización delimitada, utilizable en staging. Controles técnicos completos y validación con usuarios reales acordados.
- `[ ] EXTENDED:` Integración en entorno controlado del cliente y seguimiento observacional acotado. Revisión de seguridad e infraestructura específica.

---

## 3. Alcance Específico del Trabajo

### 3.1 Entregables Incluidos (Inclusiones)
1. `[Entregable 1: Ej. Módulo de ingesta y extracción de datos de comprobantes]`
2. `[Entregable 2: Ej. API REST con 3 endpoints protegidos para consulta]`
3. `[Entregable 3: Ej. Interfaz web básica para visualización y validación manual]`
4. `[Entregable 4: Suite de tests automatizados con verificación objetiva aprobada]`
5. `[Entregable 5: Despliegue en ambiente de Staging para prueba de usuarios]`

### 3.2 Exclusiones Explícitas (Fuera de Alcance)
- **Infraestructura de producción definitiva:** El Lab entrega el código y despliega en staging; el hosting productivo final es responsabilidad del cliente.
- **Integraciones no listadas:** Cualquier conexión con ERPs legados o bases de datos no especificadas requerirá cotización independiente.
- **Validación de mercado o ROI comercial:** El Lab garantiza funcionamiento técnico y estabilidad según tests; no garantiza incremento de ventas ni adopción masiva.

---

## 4. Protocolo de Entregas e Iteraciones (V0 / R1 / R2)

Para evitar desbordamiento de alcance y costos, las iteraciones se rigen estrictamente por el protocolo de 3 pasos:

| Hito | Descripción | Criterio de Finalización | Límite Máximo de Esfuerzo |
| :--- | :--- | :--- | :--- |
| **V0** | **Primera Entrega Funcional:** Despliegue inicial en staging basado en el alcance acordado. | Tests técnicos en verde + verificación objetiva por la fábrica. | Incluido en tarifa base. |
| **R1** | **Ronda 1 de Ajustes:** Cambios y correcciones derivados de las evidencias y feedback de la prueba real con usuarios designados. | Validación del Product Lead y cliente sobre los ajustes priorizados. | **Tope: `[X]` horas de ingeniería humana.** |
| **R2** | **Ronda 2 Final:** Ajustes menores de usabilidad o refinamiento final tras el segundo ciclo de prueba. | Aprobación final y cierre del servicio. | **Tope: `[Y]` horas de ingeniería humana.** |

> **Regla de Cierre:** El servicio se cierra formalmente al concluir R2 o al consumirse el tope de horas pactado, emitiendo el `FinalDecisionPackage` (`DOC-503`), incluso si el resultado del experimento indica que la solución debe pausarse o descartarse. Cualquier cambio sustancial, nuevo módulo o pivot posterior requiere un nuevo SOW.

---

## 5. Participantes y Gobernanza de la Prueba Real

- **Responsable Funcional por el Cliente:** `[Nombre y Correo]`
- **Usuarios de Prueba Designados por el Cliente:**
  - Usuario 1: `[Nombre, Rol]`
  - Usuario 2: `[Nombre, Rol]`
- **Compromiso del Cliente:** El cliente se compromete a que los usuarios designados ejecutarán la prueba dentro de los `[5]` días hábiles posteriores a la entrega de V0 y R1.

---

## 6. Propiedad Intelectual, Código y Licencias

1. **Propiedad del Código Generado:** Todo el código fuente desarrollado específicamente para el cliente bajo este SOW (entregado en la rama Git correspondiente) pasará a ser propiedad del cliente tras la liquidación del pago acordado.
2. **Propiedad del Motor y Herramientas:** La plataforma Startería y el motor de software factory (`sw-factory`), incluidos sus scripts, agentes y metodologías, permanecen como propiedad intelectual exclusiva de sus respectivos creadores.
3. **Ausencia de Dependencias Confidenciales:** Se certifica que el código no contendrá componentes propietarios de terceros sin licencia ni información bancaria restringida.

---

## 7. Términos Económicos y Calendario

- **Precio Total del Paquete:** `[Monto y moneda, ej. $X,XXX USD]`
- **Forma de Pago:**
  - `[50%]` a la firma de este SOW (anticipo para inicio de trabajos).
  - `[50%]` a la entrega del `FinalDecisionPackage` (`DOC-503`) tras R2.
- **Fecha Estimada de Entrega V0:** `[YYYY-MM-DD]` (típicamente 10 a 14 días laborables tras firma).

---

## 8. Aprobación y Firmas

Por el Cliente:  
`Firma: ___________________________`  
`Nombre: [Nombre del Decisor]`  
`Fecha: [YYYY-MM-DD]`  

Por Startería Lab:  
`Firma: ___________________________`  
`Nombre: [Nombre del Product Lead]`  
`Fecha: [YYYY-MM-DD]`  
