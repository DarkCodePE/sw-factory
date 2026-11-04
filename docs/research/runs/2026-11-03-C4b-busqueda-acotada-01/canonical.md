run_id: "2026-11-03-C4b-busqueda-acotada-01"
pregunta_canonica: "¿Reduce el coste por tarea del worker añadir a su prompt de implementación que localice con búsqueda acotada (Grep y Read por rangos) antes de editar, sin perder éxito?"
capa_principal: "C4b"
limitacion_actual: {"fab_sha":"2bed96f","metrica":"costUsd por tarea (agente claude, ANTHROPIC_MODEL=claude-haiku-5-5, perfil por defecto 2dff534e)","receipt":"FABRICA_HOME=~/.fabrica-ideas ANTHROPIC_MODEL=claude-haiku-5-5 bun src/cli.ts improve report calib-haiku-01  (add-subtract, n=2: 0.0218 y 0.0229)","valor":0.0224}
mecanismo: "El worker lee archivos enteros para orientarse; localizar primero con búsqueda de texto y leer solo los tramos relevantes reduce los tokens de entrada por tarea (ADR-0008; a2-vs-a2g.md: la búsqueda localizada acertó 5/5 con menos bytes)."
prediccion: {"cambio_pct":-20,"metrica":"costUsd por tarea, media del brazo candidato frente a baseline"}
metrica_primaria: "costUsd por tarea"
guardianas: ["exito_verify","diffLines"]
probe_budget: {"presupuesto_lectura":128000,"tipo_fuente":"repo","tokens_medidos":8859,"tope_consultas":30}
fuentes: ["docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md","docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md","src/profile.ts","src/agents.ts"]
presupuesto: {"horas_max":3,"usd_max":5}
inicio: "2026-11-03T18:08:32.489Z"
