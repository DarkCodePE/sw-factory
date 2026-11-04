# ADR-0007: Las fuentes son datos no confiables; lector e implementador separados

Estado: propuesto · Fecha: 2026-10-31 · Capa principal: C5 · Afectadas: C4b, C7

## Contexto
Todo texto ajeno (PDF, README y `AGENTS.md` de `ext/`, artículos, transcripciones) entra a la bóveda y vuelve a un agente que escribe código y páginas que leerán ciclos futuros: riesgo de prompt injection y de envenenamiento persistente. Hoy: el MCP de llm_wiki no marca nada como no confiable; fab sí lo hace en `fetch_url` (`src/agent/fetch-url.ts:92`); hyperresearch envuelve todo cuerpo externo en `<untrusted-source url=...>` neutralizando fences falsos (`src/hyperresearch/core/hooks.py:363-367`). ESF no trata el tema.

## Decisión
- Todo contenido de fuentes (wiki, `ext/`, barridos) llega al agente envuelto como **dato no confiable**, con el formato de hyperresearch (adoptado con pin).
- **Separación de roles**: el lector (paso 5) solo produce receta y spec en formato fijo; el implementador (paso 6) arranca en sesión limpia sin acceso a fuentes, solo con la spec. Extiende el clean room del diseño §6 (antes solo por licencia) a seguridad.
- Páginas escritas por agentes: `raw/sources/agentes/` con `trust: agent`, leídas con el mismo envoltorio.
- Nunca exponer `llm_wiki_chat` a agentes de fab.
- El crítico goldfish verifica que la spec no contenga instrucciones ajenas al objetivo (p. ej. tocar credenciales, red, archivos protegidos).

## Consecuencias
+ Una fuente maliciosa no llega directamente al agente que escribe en `src/`.
− La spec es un cuello de botella: si el lector la resume mal, el implementador no puede corregir mirando la fuente.
