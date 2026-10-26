# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

HTML, CSS y JavaScript estáticos en site/, decisión explícita del usuario.
Sin framework ni dependencias nuevas en el manifiesto raíz.

## Users

Desarrolladores y equipos técnicos que evalúan una fábrica local de software.

## Product Purpose

Instalar fab y entender cómo coordina workers, worktrees y validaciones.

## Positioning

Un flujo local de workstream, señal, change y actividades, con distintos CLIs
de agentes y un motor nativo. El usuario aporta el acceso a sus modelos.

## Operating Context

Linux glibc y macOS, x64/arm64. npm requiere Node 22; el binario independiente
no requiere Bun ni Node. El sandbox de herramientas con bubblewrap es Linux;
macOS ejecuta procesos de usuario sin aislamiento equivalente.

## Capabilities and Constraints

Workers externos: Claude Code, Codex, Antigravity y Droid, cada CLI con su login
o sus variables de entorno. Native admite anthropic, openai, chatgpt (login de
Codex) y generic-chat-completion-api. OpenRouter y Gemini solo se presentan como
compatibles vía endpoint OpenAI, sin afirmar pruebas; Ollama y vLLM son endpoints locales.

En main hay Jira, PR, validadores y puerta de merge. Triage automático, daemon,
automatizaciones, AutoWiki y Monitor se rotulan próximamente. El estado local
está en ~/.fabrica/fabrica.db; no se afirma auditoría inmutable o aislamiento absoluto.

## Brand Commitments

Nombre fab; voz técnica y austera. Logo SVG oficial aportado por el usuario;
marca #14B8A6 y texto #0B0D12. Variantes claras/oscuras sin modificar en
site/assets/brand/. No marcas, logos, textos o testimonios de los
sitios de referencia. Sin recursos externos ni fuentes descargadas.

## Evidence on Hand

Brief /home/orlando/Desktop/factory/doc/landing/brief.md y precisión posterior
del usuario sobre proveedores. README.md, packaging/npm/README.md,
src/agents.ts y src/agent/settings.ts, main 516833e.
No hay testimonios, cifras de adopción, benchmarks ni pruebas de servicios compatibles.
No se encontró LICENSE/MIT en el árbol consultado: no se atribuye esa licencia en la página.

## Product Principles

Hechos antes que promesas. Comandos utilizables. Distinción visible entre
disponible y futuro. El usuario confirmó borrador comercial sin captación.

## Accessibility & Inclusion

Teclado, foco visible, contraste, modos claro/oscuro, movimiento reducido,
lectura y comandos disponibles sin JavaScript, móvil sin scroll horizontal.
