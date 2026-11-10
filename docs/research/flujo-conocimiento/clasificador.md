# Clasificador local de fuentes (T11)

`scripts/ideas/clasificar.ts` clasifica clips Markdown, papers PDF y repos por
las 14 categorías cerradas de `VAUL-FAB/FAB/schema.md`. Usa `jevify ask` con
14 preguntas `noul` en una invocación por fuente: no necesita gestionar un
servidor HTTP ni dejar procesos residentes. Las fuentes se procesan en serie.

```bash
bun scripts/ideas/clasificar.ts /ruta/clip.md /ruta/paper.pdf /ruta/repo
bun scripts/ideas/clasificar.ts /ruta/clip.md --threshold 0.7 --max-categories 2 --max-chars 12000
bun scripts/ideas/clasificar.ts /ruta/vault/raw/sources/clip.md --write --vault /ruta/vault
```

Requisitos: Bun, `jevify` en PATH y Ollama con `qwen3.5-32k` disponible.
Los PDF requieren `pdftotext`; si no existe se devuelve un error con salida 1.
La receta predeterminada es `config/ideas/qwen35.ollama.yaml`, copiada de la
receta probada en `docs/research/flujo-conocimiento/jevify/qwen35.ollama.yaml`
del checkout de integración. Usa `reasoning_effort: none`; no usa Gemma.
`--recipe` permite seleccionar otra receta explícitamente.

## Entrada y resultado

- Markdown: cuerpo sin frontmatter inicial. Frontmatter YAML inválido falla.
- PDF: salida de `pdftotext -layout`, sin OCR ni interpretación de imágenes.
- Repo: primer README de la lista `README.md`, `readme.md`, `README.rst`,
  `README`; más nombre/descripción de `package.json`, `Cargo.toml` y
  `pyproject.toml` (también workspace.package y tool.poetry). Metadatos antes
  del README para conservarlos al truncar; no se ejecuta código del repo ni
  se siguen enlaces simbólicos en esos archivos.

Se imprime un array JSON, una entrada por fuente:
`ruta`, `categories`, `probs` (las 14), `recipe_hash`, `modelo`,
`low_confidence`, `characters_total`, `characters_used`, `truncated`.
La ruta es absoluta y canónica. El hash es el que calcula jevify sobre el
JSON canónico de la receta, no el hash de los bytes YAML.

Defaults: umbral inclusivo `p >= 0.5`, máximo 3 y 16.000 caracteres Unicode
(puntos de código). Se ordena por p descendente; los empates conservan el
orden de la taxonomía. Si ninguna supera el umbral, se devuelve la mejor y
`low_confidence: true`. `--max-categories` admite 1–3; no amplía la taxonomía.
Los scores noul son readouts del modelo, no confianza calibrada ni una
garantía de clasificación correcta. Readouts degradados, incompletos o con
hash inconsistente se rechazan.

## Escritura optativa

Sin `--write`, solo se imprime JSON. El estado temporal para jevify se escribe
en un directorio privado del sistema, con archivo 0600, y se elimina incluso
si falla la llamada. No se pone el contenido de la fuente en argv.

Con `--write`, solo se acepta `.md` regular cuya ruta real esté bajo
`<vault>/raw/sources/`. Se rechazan enlaces de archivo, escapes por directorios
y fuentes duplicadas. No se mueven clips a carpetas de categorías ni se
renombran sus rutas. PDF y repos permanecen de solo lectura.

Se modifica únicamente `categories` en el frontmatter; se conservan cuerpo,
otros campos, comentarios ajenos al valor sustituido y LF/CRLF/BOM. Admite listas flow y en bloque.
Formatos YAML no editables con seguridad (por ejemplo una raíz flow completa
o aliases dependientes de categories) fallan sin sobrescribir el clip.
Una segunda edición equivalente no reescribe el archivo.

Todas las clasificaciones y ediciones se preparan antes del primer cambio.
Cada guardado comprueba el contenido original, conserva permisos y reemplaza
atómicamente el archivo mediante temporal en su directorio. No hay transacción
entre múltiples clips: un fallo de disco posterior puede dejar un lote parcial;
tampoco sustituye un mecanismo de exclusión entre escritores concurrentes.

## Validación

`bun test tests/clasificar.test.ts` simula jevify y pdftotext, sin Ollama ni red;
`bun run typecheck` comprueba también el script importado desde las pruebas.
La ejecución real de T11 fue sin `--write`: Sparks dio `MODEL, LOOP` y el repo
jevify `SKILL, EVAL, MODEL`, ambos con 16.000 caracteres usados. Dos fuentes
tardaron 26,51 s; no es un benchmark de precisión ni una garantía de latencia.
El informe del scratchpad conserva JSON completo y probabilidades.
