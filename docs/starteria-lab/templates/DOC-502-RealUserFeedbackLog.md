# DOC-502: RealUserFeedbackLog

**Código:** DOC-502  
**Versión:** 1.0  
**Fase:** F1C — Validación con Usuarios Reales  
**Emisores:** Product Lead (Startería) & Usuario Designado del Cliente  
**Receptor:** Tech Lead / Ingeniero del Lab  
**Hito Evaluado:** `[ ] Prueba sobre V0 (Activa R1)  |  [ ] Prueba sobre R1 (Activa R2)`  
**Iniciativa:** `[Nombre de la iniciativa]`

---

## 1. Datos de la Sesión de Prueba Real

- **Fecha de la Prueba:** `[YYYY-MM-DD]`
- **Usuario Evaluador:** `[Nombre y Cargo del usuario del cliente]`
- **Acompañante por Startería:** `[Nombre del Product Lead]`
- **Duración de la Sesión:** `[Ej. 45 minutos]`

---

## 2. Evaluación del Flujo y Cumplimiento del Objetivo

- **¿Pudo el usuario completar la tarea principal sin bloqueos?** `[X] Sí  |  [ ] No`
- **¿El tiempo invertido representa una mejora frente a su método actual?** `[X] Sí (de 4 horas a 10 min)  |  [ ] No`
- **Nivel de satisfacción general (1 a 5):** `[4/5]`

---

## 3. Matriz de Hallazgos y Clasificación Formal

> **Regla de Alcance:** El Humano del Lab clasifica cada punto levantado por el cliente para determinar si corresponde a la ronda pactada (`R1`/`R2`) o si constituye un cambio sustancial de alcance.

| ID | Observación del Usuario | Impacto Operativo | Clasificación Técnica | Acción Acordada |
| :--- | :--- | :---: | :--- | :--- |
| **H-01** | "El botón de exportar Excel descarga un CSV en lugar de un .xlsx con formato." | Menor | **Ajuste Menor (Entra en R1/R2)** | La fábrica ajustará la librería de exportación para generar .xlsx nativo. |
| **H-02** | "Cuando el monto tiene coma decimal en vez de punto, arroja error de validación." | Medio | **Bug Técnico (Entra en R1/R2)** | Crear señal `DOC-302` para normalizar separadores decimales en el parser. |
| **H-03** | "Quisiéramos que además envíe un WhatsApp automático al proveedor si hay discrepancia." | Alto | **Fuera de Alcance (Change Request)** | Nueva funcionalidad no contemplada en el SOW. Cotizar en paquete `Extended`. |

---

## 4. Consumo de Horas de la Ronda

- **Horas máximas pactadas en SOW para esta ronda:** `[8 horas]`
- **Horas estimadas de ingeniería humana para H-01 y H-02:** `[3 horas]`
- **Horas de cómputo estimadas de la fábrica:** `~5 minutos de ejecución`
- **Saldo restante de horas:** `[5 horas]`

---

## 5. Autorización de Paso a la Fábrica

El Product Lead y el Tech Lead autorizan la conversión de los hallazgos `H-01` y `H-02` en señales técnicas (`DOC-302`) para ser despachadas a la fábrica de software.
