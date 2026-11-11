# Seguimiento: flujo de conocimiento

Fuente: [09 · Lo que queda por hacer](../../../techdocs/docs/investigacion/09-flujo-de-conocimiento.md). Estado legible por máquina: `tasks.json`.

| ID | Tarea | Quién | Estado |
|---|---|---|---|
| T1 | Taxonomía en `schema.md` / `purpose.md` (vault FAB) | agy | [x] hecho |
| T2 | Memoria propia basada en ai-memory (fork local endurecido) | Codex | [x] hecho (sin activar) |
| T3 | Script de exportación fab → `raw/sources/repos/` | — | [ ] pendiente (tras T1) |
| T4 | Endpoint de ingesta + temporizador en llm_wiki | — | [ ] pendiente |
| T5 | Plantilla de candidato en la skill compartida | agy | [x] hecho |
| V1 | Comprobación fab ↔ llm_wiki y ciclo 00-blueprint ↔ llm_wiki | Sonnet | [x] hecho |
| D1 | Decidir quién escribe en la bóveda + enmendar ADR-0002 | usuario | [x] orquestador tras PR |
| D2 | Nombre/ruta del proyecto (`FAB` vs `fab-research`) | usuario | [x] FAB |
| T6 | Lector con montaje RO de la bóveda en `fab exec` | Codex | [x] hecho (sin push) |
| T7 | Escritor del paso 9 (`raw/sources/agentes/`) | agy | [x] hecho (sin push) |
| T8 | Piezas 0–2: vigilancia, backlog, intake | — | [ ] pendiente |
| T9 | Actualizar docs 00/01/03/08/09 | agy | [x] hecho (sin commit) |
| T10 | Calidad de ingesta local / prueba Haiku | — | [ ] pendiente |
| T11 | Clasificador jevify (qwen3.5 en Ollama): receta probada; script hecho; falta calibrar | Codex | [x] hecho (sin push) |

## Criterios de cierre

- [x] T1: las 14 categorías y el formato de ficha están en `schema.md`; copia previa en `schema.md.bak`.
- [x] T2: fork local con historia y LICENSE; `require_approval` por defecto en true, saneado antes de la cola, acceso desconocido = denegado; `cargo test` en verde; `DISENO.md` con qué se queda y qué se quita.
- [x] T5: `SKILL.md` con plantilla YAML de candidato, visible desde Claude Code, Codex y Gemini/agy.
- [x] V1: informe con citas `archivo:línea` de lo que existe, lo propuesto y los huecos.
- [ ] Revisión del integrador (Claude) de cada entregable antes de marcarlo.
