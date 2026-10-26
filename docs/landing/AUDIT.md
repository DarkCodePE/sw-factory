# Auditoría y revisión visual

Aplicada a la landing existente, incluida la actualización de marca oficial. El
brief de producto y las respuestas del usuario rigen sobre el tema inicial.

## Hallmark

Tema inicial Cobalt (1/3), draw 087591, controles y composición conservados.
El verde azulado oficial #14B8A6 sustituye al azul del tema por petición del usuario.
`sloplint --genre modern-minimal --render`: **0 FAIL, 0 WARN**.

Tres ocurrencias dispensadas, dos motivos: gate 1 en base/tokens por fuentes del
sistema exigidas en el brief; gate 44c por hero compacto tras revisión independiente,
con la instalación visible en 1280×800 y la siguiente sección entrando en pantalla.
Se atendieron F1–F26; los casos de fotografía, slots y formularios no aplican.

La revisión independiente inicial pidió corregir el titular y agrupar los controles.
La revisión final pidió quitar una raya decorativa, corregir la nota de compatibilidad
y usar encabezados específicos de fab. Los cuatro cambios quedaron resueltos.
Tras revisar las capturas con la marca oficial, el revisor devolvió **ship** para
las correcciones y el cambio de marca, sin hallazgos materiales restantes.

## Impeccable

Integridad: coherente, con comandos reales, estados actuales/futuros, marca oficial
y controles accesibles. Se realizó auditoría técnica y pasada de polish/distill.

| Dimensión | Valoración manual | Evidencia y límite |
|---|---:|---|
| Accesibilidad | 3/4 | Teclado, foco, contraste, movimiento reducido, JS desactivado; sin lector de pantalla real. |
| Rendimiento | 4/4 | HTML/CSS/JS pequeños, SVG locales, sin dependencias, fuentes remotas ni efectos pesados; sin benchmark de Web Vitals. |
| Temas | 4/4 | Roles semánticos, dos paletas, logos correctos y preferencia persistente. |
| Responsive | 3/4 | Ocho anchos, texto al 200%, toque sintetizado; sin dispositivos físicos u otros motores. |
| Integridad | 4/4 | Producto y borrador distinguidos, sin métricas inventadas ni captación. |
| Total | 18/20 | Valoración técnica dentro del alcance probado; no certificación WCAG. |

Detector estático final: una advertencia `flat-type-hierarchy`. Es un falso positivo
al resolver los CSS importados: informa body/h2/h3=16px. Chromium calcula body=16px,
h1=71.68px, h2=48px y h3=23.6px a 1280px. No se suprimió la regla globalmente.
No quedaron problemas verificados P0/P1/P2/P3 abiertos tras las correcciones.

Los 42 controles de `browser-checks.json` pasan. El contraste mínimo medido del
texto activo es 7.81:1; borde de control 4.59:1, foco 4.88:1 y conectores 4.56:1.
Los logos oficiales se conservaron byte a byte; no se recolorearon para los controles.

### Desviación del proceso

No se ejecutaron `concept-seed` ni la tarjeta `QUALITY BAR` del motor. Se trabajó
con el brief detallado, las decisiones explícitas del usuario, el tema Hallmark
y luego la marca oficial. No se afirma cumplimiento completo del flujo de selección
de conceptos de Impeccable. Hubo revisión independiente y documentación del diseño.
El documento y su snapshot se guardan en DESIGN.md y design-system.json; los
cachés .hallmark/ y .impeccable/ no forman parte de la entrega.

## Material

Sin slots de imágenes pendientes. Los seis SVG son originales suministrados por
el usuario. La procedencia y los hashes de SVG/capturas están en provenance.json.
Las capturas son del sitio ejecutado en Chrome, no fotomontajes ni demos de un
producto futuro. El código y el diagrama son el material de esta landing.

## Validación del repositorio

La ejecución final de `bun test --max-concurrency=4` terminó con **602 pass, 0 fail**
en 67 archivos (199.83 s). `bunx tsc --noEmit` terminó con código 0.
`git diff --check` y `git diff --cached --check` no informaron errores.

Una ejecución anterior tuvo 601 pass y 1 fail en
`tests/agent-mcp.test.ts:77`: faltaba `response` en el registro de la sesión SSE.
El mismo caso pasó aislado y después pasó la suite completa. No se modificaron
ese test ni el código de MCP; se registra la incidencia observada, sin ocultarla
ni atribuirle una causa demostrada.
