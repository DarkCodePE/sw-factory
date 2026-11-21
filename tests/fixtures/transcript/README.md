# Stream de Claude

`claude-haiku.ndjson.gz` contiene 454.809 bytes de eventos de Claude Code 2.1.330 con Haiku, capturados en un turno confinado que leyó diez archivos sintéticos de texto. La proyección conserva las llamadas a Read, el texto de sus resultados y la forma de los eventos NDJSON. Se omitieron los metadatos del entorno y se redujeron las rutas de entrada al nombre de archivo. La prueba corta se obtiene seccionando el mismo stream dentro de un resultado de Read.
