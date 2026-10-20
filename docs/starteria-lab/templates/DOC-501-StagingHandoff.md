# DOC-501: StagingHandoff & TestGuide

**Código:** DOC-501  
**Versión:** 1.0  
**Fase:** F1C — Transferencia a Prueba Real  
**Emisor:** Tech Lead / Ingeniero del Lab  
**Receptores:** Product Lead (Startería) / Usuarios Designados del Cliente  
**Hito del SOW:** `[X] V0 (Primera entrega)  |  [ ] R1 (Ajustes ronda 1)  |  [ ] R2 (Ajustes ronda 2)`  
**Iniciativa:** `[Nombre de la iniciativa]`

---

## 1. Datos de Acceso al Entorno de Staging

- **URL de la Aplicación de Prueba:** `https://staging-[iniciativa].starteria-lab.invalid`
- **Ventana de Disponibilidad:** Del `[YYYY-MM-DD]` al `[YYYY-MM-DD]` (10 días corridos).
- **Entorno de Datos:** Datos 100% sintéticos y seguros (`DOC-203`).

### Cuentas de Acceso para Pruebas
| Rol | Correo / Usuario | Contraseña Temporal | Propósito de Prueba |
| :--- | :--- | :--- | :--- |
| **Operador Principal** | `operador1@cliente-test.invalid` | `TestPass2026!` | Carga de archivos y conciliación. |
| **Supervisor** | `supervisor@cliente-test.invalid` | `TestPass2026!` | Visualización de reportes finales. |

---

## 2. Alcance Funcional Habilitado en esta Entrega

### Qué SE PUEDE probar en esta versión:
1. `[Funcionalidad A: Carga de archivos PDF de facturas B]`
2. `[Funcionalidad B: Ejecución del algoritmo de cruce automático]`
3. `[Funcionalidad C: Descarga de reporte de discrepancias en Excel/CSV]`

### Qué NO ESTÁ habilitado aún (o fuera de alcance):
- No hay sincronización automática en tiempo real con ERP (se requiere carga manual de archivo).
- No hay recuperación de contraseñas por correo (usar las credenciales provistas arriba).

---

## 3. Guía Paso a Paso para el Usuario de Prueba (Test Scenario)

Se solicita al usuario del cliente seguir el siguiente recorrido para validar si la herramienta resuelve su problema operativo:

1. **Paso 1:** Ingresar a la URL e iniciar sesión con la cuenta de Operador Principal.
2. **Paso 2:** Ir a la pestaña "Cargar Comprobantes" y subir el archivo de prueba `sample_invoice.pdf` adjunto.
3. **Paso 3:** Presionar el botón "Ejecutar Conciliación".
4. **Paso 4:** Observar la tabla de resultados. Verificar que la factura número `1042` figure con estado `DISCREPANCY` por un monto de `$150`.
5. **Paso 5:** Exportar el reporte y anotar cualquier observación en la bitácora `DOC-502`.

---

## 4. Canales para Reportar Observaciones

- **Reunión de Feedback de 30 minutos:** Agendada para el `[YYYY-MM-DD HH:MM]`.
- **Formulario / Bitácora asíncrona:** Registro directo en `DOC-502: RealUserFeedbackLog`.
