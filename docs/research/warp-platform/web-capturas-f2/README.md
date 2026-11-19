# Recorrido manual de F2

[V] Capturas de Chromium con `agent-browser --session fabf2 --args --no-sandbox`, servidor real `bun run fab web --write --port 0` y `FABRICA_HOME` temporal. Todos los registros se generaron para la prueba; el actor inicial es `fixture` y las decisiones llevan `web`. No se abrió ninguna base personal.

- `aprobar-{antes,despues}.png`: revisión awaiting → approved, con mensaje tras redirección 303.
- `comentar-{antes,despues}.png`: comentario con `<script>` como texto; awaiting → commented. El borrador sobrevivió al perder el foco y esperar un sondeo de 2 s.
- `reintentar-{antes,despues}.png`: change failed → pending, con una activity nueva.
- `responder-{antes,despues}-movil.png`: pregunta abierta → answered; activity waiting_reply → pending; pantalla 390 × 844 sin desbordamiento horizontal.

[V] `recorrido.json` conserva las comprobaciones finales de la base y del navegador sin credenciales de sesión. Las capturas de escritorio usan 1440 × 1000. Se verificaron consola y errores vacíos. El detector de Impeccable devolvió `[]`.

[V] `body-probe.ts` prueba que el servidor devuelve 413 tras recibir más de 16 KiB aunque el cliente no haya terminado el cuerpo chunked. Crea y elimina su propia base sintética. Uso: `bun docs/research/warp-platform/web-capturas-f2/body-probe.ts "$PWD"`. La mutación A13 relaja el límite nativo y este probe falla por ausencia de rechazo temprano; el timeout de 5 s solo evita colgar la prueba.
