# Comandos ejecutados (2026-11-07)

PATH previo en cada comando: `export PATH=/home/orlando/.nvm/versions/node/v22.22.1/bin:$PATH`. Rama `feat/t2-corpus`, sin cambios en `src/`.

```bash
bash bench/t2-cualificacion/prepare.sh /tmp/t2-piloto      # 25 s; suite.json sha256 cc5c80f1ebdeeec9429dad97f547b1e46b33b28b8fa92c232b5cab7429d6634f
FABRICA_HOME=~/.fabrica-ideas bun ./src/cli.ts profile import bench/t2-control/control.json   # -> digest del control
```

## Suite piloto
Semilla **20261107** (`random.Random`): `sample(3 grupos de development ordenados)` y luego `choice` de una tarea de development por grupo. Tareas:
`xmltodict-ns-nombre`, `sortedcontainers-count-ultimo`, `tabulate-update-lines-reset` (`suite-piloto.json`, copia en `/tmp/t2-piloto/suite-piloto.json`, que es la ruta registrada). Digest de la suite según el experimento: `8a5c6c5ea16c17fa05791790260cf2d7f35b7aca7f51a8ae2f54ebd79957a582`.

## Digests
- baseline: `2dff534e629bba57f035f8c59aa154664a6f1b8e7dd149d585fab524af7bb1b6`
- candidate: `64f463d95c679a4d17ab77b70f2f5a533a1ab0f5624ad987573c1fb22f4818ea`
- control: `12127bc39b371c74c9e75c81944cc662f4c1f7f209e767fd0bfa413ebfc2d49b`

## Experimento
```bash
FABRICA_HOME=~/.fabrica-ideas bun ./src/cli.ts improve create --experiment-id t2-piloto-01 \
  --baseline 2dff534e… --candidate 64f463d9… --control 12127bc3… (digests completos arriba) \
  --repeated-baseline --suite /tmp/t2-piloto/suite-piloto.json

ANTHROPIC_MODEL=claude-haiku-5-5 FABRICA_HOME=~/.fabrica-ideas systemd-inhibit --what=sleep:idle --why="t2 piloto" \
  bun ./src/cli.ts improve run t2-piloto-01 --split development --repeats 1 --agent claude --confine --concurrency 4
# 12 corridas registradas (semilla 1290393635), 17:22:25 -> 17:26:26 (241 s)

FABRICA_HOME=~/.fabrica-ideas bun ./src/cli.ts improve report t2-piloto-01 --json > report.json
```
