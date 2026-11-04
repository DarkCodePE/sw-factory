run_id: 2026-10-30-B-esf-01
loop: B
pregunta_canonica: "si ejeucta sobre ESF priemro hasle git pull y luego ejecuta, y verifca a graft"
capa_principal: todas (inventario de fábrica completa, pasada por capa C0-C9)
repo: {name: esf, url: https://github.com/mitkox/esf, local: ext/esf, sha: d901657fce1af2320ba4b235b4c436020fb11a96, prev_sha: 804fb461068972a707628b0a3243e4db09cafb0c, release: v0.7.1-rc.1, license: MIT, license_sha256: bbff8983f1ba6ec0723c1566af28d2e1e2109ac478361bc8132302668ae2ce89}
fab_sha: 29d4dd3de9105066773d32e8f6df43e0fca23b3d
graft: {version: 0.24.1, build: ok, nodes: 2560, files: 309, check: "graph in sync"}
limitacion_actual: "registro provisional: ESF sin last_sha ni evidencias con línea"
fuera_de_alcance: [implementar candidatos, ejecutar código de ESF, medir benchmarks]
presupuesto: {fuentes_max: 1 repo, horas_max: 3, usd_max: 10, concurrencia_max: 4, reserva_cierre_pct: 25}
inicio: 2026-10-30T00:36:28-05:00
fin: 2026-10-30T00:55:32-05:00
