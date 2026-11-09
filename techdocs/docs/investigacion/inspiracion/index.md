# Inspiración

Esta sección recopila el estudio y evaluación sistemática de **repositorios y sistemas de agentes externos** analizados para extraer patrones de arquitectura, invariantes de dominio y lecciones prácticas aplicables a la software factory propia (**fab**).

Cada repositorio evaluado se analiza bajo un principio de rigor técnico:
1. **Fijación estricta a commit**: las conclusiones, citas y evidencias corresponden a un snapshot inmutable del código upstream.
2. **Evaluación crítica sin adopción ciega**: se distingue entre el problema que resuelve la pieza upstream, su coste de adaptación y si conviene o no implementarlo en la fab.
3. **Respeto a las licencias de software libre**: se identifican formalmente las licencias upstream (MIT, Apache-2.0) y sus obligaciones de atribución antes de reutilizar conceptos o código.

---

## Repositorios evaluados

| Repositorio / Proyecto | Documento en fab | Licencia | Commit fijado | Resumen en una frase |
|---|---|---|---|---|
| [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) | [02 · dsh-superagent](02-dsh-superagent.md) | MIT | `8c32a9dc` | Agente proactivo con gate de admisión determinista, Mandatos inmutables y ejecución desacoplada por worktrees. |
| [`mitkox/dsh-herdr`](https://github.com/mitkox/dsh-herdr) | [03 · dsh-herdr](03-dsh-herdr.md) | Apache-2.0 | `2d74cf86` | Puente de telemetría pasivo que lee journals append-only y reporta estados del host a Herdr mediante secuencias OSC 7501. |

---

## Índice de la serie DSH

El ecosistema DeepSeek Harness (DSH), su prototipo de superagente y su monitorización en Herdr se desglosan en cinco entregas estructuradas:

1. **[01 · DSH: panorama general y ecosistema](01-dsh-panorama.md)**:  
   Visión de conjunto de DeepSeek Harness visto desde fuera, arquitectura de bundles Cordis y mapa de relaciones entre el host web, el superagente y el monitor.

2. **[02 · dsh-superagent: arquitectura, dominio y ejecución](02-dsh-superagent.md)**:  
   Desglose del modelo hexagonal: pipeline `Trigger → Eval → Mandate → Ticket → Assignment → Channel`, matriz de admisión, regla de shell a 5 segundos y panel «needs you».

3. **[03 · dsh-herdr: telemetría, journals y protocolo OSC 7501](03-dsh-herdr.md)**:  
   Mecanismo de monitorización read-only: decodificación tolerante de journals zstd, agregación jerárquica de estados y especificación empírica de OSC 7501 sobre Herdr.

4. **[04 · Interacción entre superagent y dsh-herdr: puntos de contacto y huecos](04-dsh-interaccion-y-huecos.md)**:  
   Análisis de integración: por qué ambos repos no se conocen directamente, qué ve Herdr en tiempo de ejecución, el gran hueco semántico de «needs you» y el hallazgo de tramas zstd en Node 22.

5. **[05 · Qué tomar de DSH y dsh-herdr para la fab](05-dsh-que-tomar-para-fab.md)**:  
   Matriz de decisión consolidada (tomar vs no tomar) y propuesta concreta de emisión nativa de OSC 7501 con registros hijos `id=<ticketId>` para la flota de agentes de la fab.
