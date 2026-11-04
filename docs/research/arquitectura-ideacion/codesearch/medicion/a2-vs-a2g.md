# A2 frente a A2 + graft: resultados (2026-11-03)

Protocolo y criterios: `a2-vs-a2g-prereg.md`, escrito antes de ver resultados. Una ejecución por celda: los resultados son **indicativos**.

Los artefactos brutos (las envolturas `m.sh`, un `log.jsonl` y un `respuestas.md` por sesión, y `resumen.py`) están en el scratchpad de la sesión, en `medicion-a2g/`, y no están versionados.

## Acierto

A = acierto, P = parcial. Repos: opencode (oc) y deer-flow (df), tareas T1–T5 cada uno.

| Sujeto | Brazo | oc T1 | oc T2 | oc T3 | oc T4 | oc T5 | df T1 | df T2 | df T3 | df T4 | df T5 | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | A2 | A | A | A | A | A | A | A | A | P | A | 9A 1P |
| Sonnet 5.5 | A2g | A | **P** | A | A | A | A | A | A | P | A | 8A 2P |
| agy (Gemini 3.8 Flash) | A2 | A | A | A | A | A | A | A¹ | A | P | A | 9A 1P |
| agy (Gemini 3.8 Flash) | A2g | A | A | A | A | A | A | A¹ | A | P | A | 9A 1P |
| Codex (GPT-6.1-Sol) | A2 | A | A | A | A | A | A | A¹ | A | P | A | 9A 1P |
| Codex (GPT-6.1-Sol) | A2g | **P** | A | A | A | A | A | A | A | P | A | 8A 2P |

¹ La instalación se sitúa en la función `_build_runtime_middlewares` de `tool_error_handling_middleware.py` y no en las líneas :456/:487. Se cuenta como acierto porque el archivo y la función son los correctos.

- **df T4 parcial en las 6 sesiones.** Todas citan `models/factory.py:536` `create_chat_model`, pero ninguna cita `models/selection.py:52` `resolve_model_control`. Todas resuelven la elección del modelo en `lead_agent/agent.py` (`_resolve_model_name`). Es probable que la verdad de referencia de T4 esté mal planteada: `resolve_model_control` interpreta texto de control y no es la ruta de elección por petición. Se mantiene la corrección prerregistrada; queda como seguimiento revisar esa verdad.
- **Sonnet A2g, oc T2 (P).** `lector callers executeTool` le devolvió "1 referencia dentro de step.ts". Respondió "su único llamador es el propio step.ts" sin la línea del llamador (:126), y situó `Permission.assert` en "~:228" cuando la línea real es la :222.
- **Codex A2g, oc T1 (P).** Hizo dos consultas `lector ask`. Explica bien el mecanismo (`due` :409, `summarize` :438, `layer` :239), pero no cita la función `compact` (:284).
- **Corrección de la verdad:** `verdad.md` situaba `assert` en `permission.ts:228`; la línea real es la :222. T3 de opencode se recontó con `graft/` excluido: 55 ocurrencias en 40 archivos.

## Coste

Bytes y comandos de las herramientas registrados por la envoltura, sumando los dos repos. Tokens = bytes/4. No incluye los tokens propios del modelo.

| Sujeto | Brazo | Comandos | Llamadas al grafo | Bytes | ≈ tokens | Shell (s) |
|---|---|---|---|---|---|---|
| Sonnet 5.5 | A2 | 50 | 0 | 114 036 | 28,5 k | 0,4 |
| Sonnet 5.5 | A2g | 50 | 5 | 100 970 | 25,2 k | 4,9 |
| agy | A2 | 82 | 0 | 664 465 | 166,1 k | 0,7 |
| agy | A2g | 57 | 7 | 490 185 | 122,5 k | 5,7 |
| Codex | A2 | 66 | 0 | 300 680 | 75,2 k | 0,4 |
| Codex | A2g | 53 | 12 | 202 053 | 50,5 k | 21,6 |

Variación de A2g frente a A2:

| Sujeto | Bytes | Comandos |
|---|---|---|
| Sonnet | −11 % | 0 % |
| agy | −26 % | −30 % |
| Codex | −33 % | −20 % |

- **Uso del grafo.** Se usó poco: 5, 7 y 12 llamadas sobre 50–57 comandos.
  - Sonnet usó `skeleton` (2), `ask` (1) y `callers` (2), todo en opencode; en deer-flow no lo usó.
  - agy usó sobre todo `skeleton`.
  - Codex usó sobre todo `ask`, más `callers`.
  - Nadie usó `map`.
- **La varianza entre sesiones es mayor que el efecto.** agy A2 gastó 452 KB solo en df T1, con un único volcado de `rg` muy amplio. Sin esa tarea, la diferencia de agy sería mucho menor. Con una ejecución por celda no se puede separar el efecto del brazo de la suerte de cada sesión.
- **Latencia.** Cada llamada al grafo tarda 0,6–4 s, frente a milisegundos de `rg`/`sed`. Al tiempo total del agente le pesa poco frente al tiempo del modelo, que no se midió.

## Aislamiento

- **Envoltura.** Las 6 sesiones pasaron todas sus lecturas por `m.sh`; ninguna se saltó la envoltura en lo que muestra el panel.
- **Sonnet.** Corrió sin hooks, sin MCP y sin skills.
- **Codex.** Corrió con sus MCP desactivados para la sesión.
- **agy.** Conservaba el MCP global de graft.
  - En sus conversaciones, los nombres de las 6 herramientas de graft aparecen todos exactamente el mismo número de veces (13 y 16 por conversación). Eso encaja con la lista de herramientas repetida en cada turno, no con llamadas.
  - Además, sus respuestas en A2 no citan nada que solo dé el grafo.
  - Queda como **probable sin uso, no verificado del todo**: el registro es binario.

## Lectura frente a la regla prerregistrada

- **Acierto.** A2g no supera a A2. Pierde un parcial en 2 de 3 sujetos (25A 5P frente a 27A 3P). Una de las dos pérdidas sí está ligada al grafo: el `callers` de Sonnet le dio una respuesta más vaga. La otra no tiene una causa clara en el grafo.
- **Coste.** A2g reduce un 20 % o más los bytes o los comandos en 2 de 3 sujetos (agy y Codex), es decir, en la mayoría, como pide la regla. En Sonnet, que ya era el más eficiente sin grafo, el ahorro es pequeño (−11 % de bytes).
- **Veredicto.** Ni se cumple "sale del bucle" ni se cumple con limpieza "complemento recomendado", porque hay una pequeña pérdida de acierto.
  - El grafo **ahorra salida de herramientas a los modelos que exploran con volcados amplios** (agy, Codex).
  - A un modelo que ya busca con precisión (Sonnet) **apenas le aporta**, y su `callers` puede inducir respuestas vagas cuando devuelve pocas aristas.
  - Se mantiene como **complemento opcional**, no como paso obligatorio del bucle. Su uso más claro es `skeleton` frente a leer un archivo entero.
  - Para afirmar más harían falta varias ejecuciones por celda.

## No medido
- Tokens propios de cada modelo (prompt y razonamiento) y tiempo total de cada sesión.
- Más de una ejecución por celda, y por tanto la varianza.
- Redacciones R2 y R3: solo se usó R1, en español.
