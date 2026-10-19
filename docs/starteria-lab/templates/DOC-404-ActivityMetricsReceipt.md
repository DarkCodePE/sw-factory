# DOC-404: ActivityMetricsReceipt

**Código:** DOC-404  
**Versión:** 1.0  
**Fase:** F1C — Auditoría de Consumo y Costes de `sw-factory`  
**Emisor:** Motor de Métricas de la Fábrica (SQLite `activities`)  
**Receptor:** Ingeniero del Lab / Liquidación SOW  
**Change ID:** `[hash-del-change]` | **Activity ID:** `[hash-actividad]`

---

## 1. Datos de Ejecución

- **Workstream:** `[slug-del-workstream]`
- **Tipo de Actividad:** `implementation`
- **Worker ID:** `w1-34891`
- **Agente / Proveedor:** `native (OpenAI GPT-4o / Qwen3.5-32k)`
- **Fecha de Inicio:** `[YYYY-MM-DDTHH:MM:SSZ]`
- **Fecha de Finalización:** `[YYYY-MM-DDTHH:MM:SSZ]`
- **Duración Total:** `68 segundos`

---

## 2. Consumo de Recursos y Turnos

| Métrica | Valor Observado | Límite / Presupuesto | Estado |
| :--- | :--- | :--- | :---: |
| **Turnos del Modelo (Turns)** | 6 turnos | Máximo 32 | **OK** |
| **Llamadas a Herramientas (Tool Calls)** | 5 calls (Read: 2, Edit: 1, Execute: 2) | Sin límite | **OK** |
| **Reintentos por Error de Stream** | 0 reintentos | Máximo 2 | **OK** |
| **Reintentos de Actividad (`retryCount`)** | 0 | Máximo 3 | **OK** |

---

## 3. Desglose de Tokens de Modelo

- **Tokens de Entrada (Prompt Tokens):** `14,250 tokens`
- **Tokens de Salida (Completion Tokens):** `1,820 tokens`
- **Tokens Acumulados de la Sesión:** `16,070 tokens`

---

## 4. Estimación de Coste Técnico de Inferencia

- **Tarifa Base del Modelo:** `$2.50 / 1M prompt | $10.00 / 1M completion`
- **Coste de Entrada:** `~$0.0356 USD`
- **Coste de Salida:** `~$0.0182 USD`
- **Coste Técnico Total de este Change:** **`~$0.054 USD`** *(o $0.00 si se ejecuta con Ollama local en GPU propia).*

> **Nota para el SOW:** Este coste de cómputo representa el gasto directo de máquina de la fábrica. Es independiente de las horas de consultoría y diseño del Humano del Lab y de Startería pactadas en el `LabSOW` (`DOC-103`).
