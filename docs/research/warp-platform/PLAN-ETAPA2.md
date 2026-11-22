# Plan de la etapa 2: métricas completas, créditos y nube (T108–T119)

Decisión de partida: **D14**, en `task.json`. fab corre igual en local y en una máquina en la nube del dueño. Las métricas replican las de Warp, con el coste en tres componentes, y se añade un sistema de créditos. Siguen vigentes D-F (la web nunca da más poder que la CLI) y D-K (secretos solo por nombre).

## Fases
- **F10, medición:** T108 (modelo y tokens), T109 (inferencia, cómputo y plataforma) y T110 (atribución por worker, usuario, fuente y PR).
- **F11, dashboard:** T111 (pestañas y tarjetas), T112 (productividad), T113 (gasto) y T114 (jueces y puesta en marcha).
- **F12, créditos:** T115 (libro), T116 (reserva y liquidación en el pool) y T117 (créditos en la web).
- **F13, nube:** T118 (modo servidor) y T119 (usuarios, roles y login).

## Olas de ejecución
Implementan Codex sol 6.2, Sonnet y AGY, con skip permissions. Fable solo verifica; si se queda sin cuota, verifica Codex.

| Ola | Tareas | Quién | Notas |
|---|---|---|---|
| 0, diseño | T115+T116, T118+T119 | Codex diseña, Fable verifica el diseño | Tocan dinero, autenticación y exposición a red: diseño antes de código |
| 1 | T108 · T111 · T118 | Codex · Sonnet · AGY | Archivos distintos, en paralelo |
| 2 | T109+T110 · T112+T114 · T119 | Codex · Sonnet · Codex (segunda pestaña) | T119 sale del diseño ya verificado |
| 3 | T113 · T115+T116 | Sonnet · Codex | El libro de créditos lleva una segunda pasada de Fable obligatoria |
| 4 | T117 | Sonnet | Necesita T115 y T119 |

En cada ola:
1. Cada rama se verifica con Fable: mutaciones, exploits y suite.
2. Los hallazgos vuelven al implementador; si hay altos, se hace una segunda pasada.
3. Se crea una rama de integración por ola y Fable verifica la integración.
4. Se abre el PR a `release/0.1.0-rc.12`; la CI debe pasar en verde.

El e2e (`bun run e2e`) crece con cada ola: pestañas de métricas, un change sin créditos que no arranca y el login en modo servidor.

## Decisiones del dueño pendientes
1. **Login en nube (T119):** OIDC con GitHub, con Google o con los dos.
2. **Tarifas por defecto (T109, T115):** cómputo por hora de cada runner, tarifa de plataforma por run y conversión de USD a créditos.
3. **Recargas (T117):** solo manuales del owner, o con pago externo más adelante.
4. **Dónde despliega T118:** el proveedor de la VM de prueba.

Hasta que decidas, cada tarea arranca con su valor por defecto:
1. GitHub;
2. cómputo local 0, plataforma 0 y 1 crédito = 0,01 USD;
3. recargas manuales;
4. una VM desechable.
