# DOC-102: ExecutionChoice

**Código:** DOC-102  
**Versión:** 1.0  
**Fase:** F1 — Selección de Modalidad de Ejecución  
**Emisor:** Cliente / Startería Platform  
**Receptores:** Product Lead (Startería) / Solution Architect (Startería Lab)  
**ID de Transacción:** `EXC-[AÑO]-[ID_INICIATIVA]`

---

## 1. Identificación del Encargo

- **Iniciativa Relacionada:** `[Nombre de la iniciativa / Brief]`
- **Ref. DecisionBrief:** `DOC-101-[ID_BRIEF]-v[VERSION]`
- **Empresa Cliente:** `[Nombre de la empresa]`
- **Decisor Autorizado:** `[Nombre, Cargo, Correo corporativo]`
- **Fecha de Selección:** `[YYYY-MM-DD HH:MM:SS]`

---

## 2. Modalidad de Ejecución Autorizada

El cliente ha revisado el `DecisionBrief` preliminar y selecciona formalmente la siguiente ruta de trabajo:

```
[ ] MODALIDAD A: Cliente por su cuenta (Exportar ActionBrief)
[ ] MODALIDAD B: Startería Guided (Platform B1: Iniciativa | B2: Portafolio)
[X] MODALIDAD C: Startería Lab (Delegación técnica asistida con fábrica de software)
```

---

## 3. Condiciones y Límites del Compromiso Inicial

Al seleccionar la **Modalidad C (Startería Lab)**, las partes declaran y acuerdan:

1. **Elegibilidad (Lab Eligibility):**
   - El encargo comprende un entregable digital técnico acotado.
   - El cliente garantiza la disponibilidad de al menos un (1) usuario operativo real para probar el prototipo en staging.
2. **Frontera de Confidencialidad y Datos:**
   - La construcción se realiza sobre ambientes de desarrollo aislados con datos sintéticos (`DOC-203`).
   - El cliente autoriza el procesamiento de instrucciones mediante herramientas de software asistidas por inteligencia artificial sin almacenamiento de secretos ni PII.
3. **No-Canonicalización Prematura:**
   - Esta elección autoriza la elaboración del `LabSOW` (`DOC-103`) y el scouting técnico preliminar (`DOC-201`).
   - No constituye compromiso de pago final hasta la firma formal del SOW.

---

## 4. Registro de Autorización

- **Firma digital / Aceptación electrónica:**  
  `Hash de confirmación: [SHA-256 o timestamp de auditoría]`  
  `IP / Identificador de sesión: [IP de confirmación]`  
  `Estado: AUTHORIZED_BY_CLIENT`
