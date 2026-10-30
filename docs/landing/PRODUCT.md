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

Instalar fab y distinguir la fábrica que coordina el flujo del agente de código que ejecuta una tarea.

## Positioning

La fábrica de software en tu terminal. La fábrica organiza workstreams, señales,
changes y actividades; el agente de código ejecuta tareas. El estado es SQLite
local y el código vive en Git. Esta web es explicativa, no una consola operativa.
Los modelos pueden estar en endpoints locales o remotos; el usuario aporta su acceso.

## Operating Context

Linux glibc y macOS, x64/arm64. npm requiere Node 22; el binario independiente
no requiere Bun ni Node. El sandbox de herramientas con bubblewrap es Linux;
macOS ejecuta procesos de usuario sin aislamiento equivalente.

## Capabilities and Constraints

Workers anunciados en la landing: `claude`, `codex` y `agy`, cada CLI con su login
o sus variables de entorno. La decisión editorial no elimina otros adaptadores del runtime. Native admite anthropic, openai, chatgpt (login de
Codex) y generic-chat-completion-api. OpenRouter y Gemini solo se presentan como
compatibles vía endpoint OpenAI, sin afirmar pruebas; Ollama y vLLM son endpoints locales.

En main hay Jira, PR, validadores y puerta de merge. Triage automático, daemon,
automatizaciones, AutoWiki y Monitor se rotulan próximamente. El estado local
está en ~/.fabrica/fabrica.db; no se afirma auditoría inmutable o aislamiento absoluto.

## Brand Commitments

Nombre fab; voz técnica y austera. Lockup original de cabeza de castor y wordmark fab, decidido por el usuario;
marca #14B8A6 y texto #0B0D12. Variantes claras/oscuras en
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

## Segunda pasada

Demo del CLI capturada con Jira y workers simulados en Git/SQLite temporales.
Muestra QA FAIL, merge bloqueado, QA PASS y merge permitido; no ejecuta comandos
desde el navegador ni demuestra reparación de un fallo de producción. Se conservan
las capacidades y estados del producto; el diagrama Archify reutiliza el de main.

## V2 source review

Main b7ded02 was checked against the v2 brief. Worktrees are per change, merge goes
to the current branch, and pending/FAIL validators block only requested validation
(unless --force). Triage is promotion, not an existing AI classifier. Investigation
returns a specification report without guaranteeing a spec.md file. Sandbox claims
apply to native tools on Linux, with local user processes on macOS and external
CLIs retaining their own policies. No immutable signal or perfect-code claim.
The beaver head is the brand isotype; header, footer and the decorative session node are its three visible appearances.

## Contrato C — 2026-10-27

Base c8d4edd. Auto con Jev clasifica candidatos y usa relativeCost configurado,
con reintentos y rotación antes de emitir texto. Omni enruta por cuenta/grupo de
cuota con catálogo ToS y autorización de perfiles declarados de pago; costTier
es una declaración operativa, no una tarifa verificada. Son configuraciones
alternativas. Sin promesas de gratuidad. Evidencia y decisiones en POSITIONING.md.
