# ADR-0002: llm_wiki ingiere; los agentes leen sus archivos, no su app

Estado: propuesto (v0.2) · Fecha: 2026-10-31 · Capa principal: C7 · Afectadas: C5

## Contexto
v0.1 hacía del MCP de llm_wiki el acceso de los agentes. Verificado: el MCP es un proxy stdio a `127.0.0.1:19828` (`mcp-server/src/api-client.ts:1`), que solo existe con la app Tauri abierta (`src-tauri/src/lib.rs:606`); fab ejecuta MCP stdio con `--unshare-net` salvo `allowNetwork: true` (`src/agent/mcp-sandbox.ts:30`), lo que da toda la red; y los adaptadores `claude`/`codex`/`agy` de fab son CLIs externos que no leen la config MCP de fab (`src/agents.ts:89`). Pero un proyecto de llm_wiki es una carpeta: fuentes en `raw/sources/`, páginas en `wiki/*.md`.

## Decisión
- llm_wiki, proyecto **fab-research**, es la única bóveda: **ingiere** (MinerU, caption, grafo) y es la UI del operador.
- Los agentes **leen** `<proyecto>/wiki/` como archivos, montados solo-lectura en el sandbox, con `rg`; sin app, sin red. El contenido se les entrega envuelto como no confiable (ADR-0007).
- Los agentes **escriben** solo en `<proyecto>/raw/sources/agentes/` con frontmatter `trust: agent`; llm_wiki lo ingiere.
- El MCP de llm_wiki es **opcional** para sesiones interactivas con la app abierta; nunca se expone `llm_wiki_chat` (tiene `shell.exec` y `web.search`: `src-tauri/src/agent/tools.rs`).
- hyperresearch, agent-reach y los informes de agentes dejan su salida en `raw/sources/`.
- `docs/research/` de fab guarda decisiones y evidencia de fab. Excepción explícita: las fichas Loop B (`docs/research/analisis/<repo>.md`) siguen en fab porque llevan `archivo:línea@sha` que el registry referencia.
- Video: fuente de segunda clase; transcripciones vía agent-reach (YouTube) hasta que exista un script con dueño.

## Alternativas
- **Carpeta markdown en git sin llm_wiki** (agy): pierde MinerU, caption y UI; la lectura por archivos ya da el modo headless.
- **Bóveda de hyperresearch**: tiene UI, grafo y PDF, pero no caption de imágenes ni proyectos por cliente.
- **graphicle**: ingiere video; duplica graft. Reconsiderar si el video pasa a ser fuente principal.

## Consecuencias
+ Modo headless sin red ni app.
− La búsqueda de agentes es léxica (`rg`), no semántica, salvo con la app abierta.

## Enmienda (2026-11-09)

1. **Quién escribe en la bóveda (decisión D1):** Se enmienda el punto 3 de la decisión original («Los agentes escriben solo en...»). Los agentes no escriben directamente en la bóveda: quien escribe en `<proyecto>/raw/sources/agentes/` (con frontmatter `trust: agent`) es el **orquestador**, y únicamente **tras revisión humana previa / PR aprobada** (decisión D1; ver `techdocs/docs/investigacion/09-flujo-de-conocimiento.md` §1 y §2). Los agentes en sandbox confinado permanecen en estricto solo-lectura (`--ro-bind`).
2. **Repos de referencia Loop B:** Se enmienda el punto 6 («Las fichas Loop B siguen en fab»). La autoridad técnica del análisis exhaustivo (`archivo:línea@sha`) permanece en fab (`docs/research/analisis/<repo>.md`), pero el orquestador exporta de forma idempotente una **ficha de catálogo derivada** a `<proyecto>/raw/sources/repos/<repo>/<revisión>.md` para que otros proyectos puedan descubrir el repo y sus módulos reutilizables desde llm_wiki (`09-flujo-de-conocimiento.md` §1).
3. **Nombre del proyecto (decisión D2):** El proyecto en llm_wiki se denomina **`FAB`** (en lugar de `fab-research`), y su ruta en disco es configurable por variable de entorno.
