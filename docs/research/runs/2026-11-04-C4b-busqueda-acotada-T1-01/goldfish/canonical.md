run_id: "2026-11-04-C4b-busqueda-acotada-T1-01"
pregunta_canonica: "En tareas que requieren localizar código (suite T1, incluye TypeScript), ¿reduce el coste por tarea del worker añadir a su prompt de implementación que localice con búsqueda acotada (Grep y Read por rangos) antes de editar, sin perder éxito?"
capa_principal: "C4b"
limitacion_actual: {"fab_sha":"952afb5","metrica":"costUsd por tarea (agente claude, ANTHROPIC_MODEL=claude-haiku-5-5, perfil baseline 5b2122cd)","receipt":"FABRICA_HOME=~/.fabrica-ideas bun src/cli.ts improve report c4b-busqueda-acotada-01 --json (brazo baseline, suite T0, n=5, sd 0.0015); calib-ts-01 en ts-locate-rule: 0.0350","valor":0.02235}
mecanismo: "El worker lee archivos enteros para orientarse; localizar primero con búsqueda de texto y leer solo los tramos relevantes reduce los tokens de entrada por tarea (ADR-0008; a2-vs-a2g.md: la búsqueda localizada acertó 5/5 con menos bytes)."
prediccion: {"cambio_pct":-20,"metrica":"costUsd por tarea, media del brazo candidato frente a baseline"}
metrica_primaria: "costUsd por tarea"
guardianas: ["exito_verify","diffLines"]
probe_budget: {"presupuesto_lectura":128000,"tipo_fuente":"repo","tokens_medidos":8859,"tope_consultas":30}
fuentes: ["docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md","docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md","src/profile.ts","src/agents.ts"]
presupuesto: {"horas_max":4,"usd_max":10}
tipo_cambio: "perfil"
tier: "T1"
suite: "/home/orlando/.fabrica-ideas/t1/suite.json"
suite_sha256: "45f1ce6a51722e8d88d38fff6e47789c5b1af616f1f806f75f9abab1a81e67e0"
inicio: "2026-11-04T02:56:32.766Z"
