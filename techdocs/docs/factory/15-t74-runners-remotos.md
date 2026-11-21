# 15 · T74 · Guía del dueño: runners remotos por SSH

Un **runner remoto** es otra máquina tuya donde corre el proceso del agente de un workstream, confinado, sobre una copia del código. Casa (`fab`) sigue decidiendo todo: la base, los gates, los validadores, las puertas y el merge no salen de tu máquina. Diseño en `docs/research/warp-platform/diseno/T74.md`; decisión D10 sobre la credencial del modelo.

!!! warning "Qué sale de casa"
    - **Sale el código** del workstream (todo su historial la primera vez; después, solo lo nuevo). `fab runner add --ssh` y `fab ws runner` te lo recuerdan, y la asignación deja un evento.
    - **No sale ninguna credencial**: ni del proveedor del modelo, ni de git, ni de GitHub, ni variables declaradas (D-K). El mensaje que viaja no tiene campo para ellas.
    - Un turno remoto corre **de un disparo**. Si el perfil define runners por rol, `fab run --live` bloquea los turnos que resuelven a SSH. Con solo un runner remoto para todo el workstream, el pool rechaza `--live` al arrancar. Un turno remoto con `env` o `mcp` declarados se bloquea (`ENV_NOT_REMOTE`, `MCP_NOT_REMOTE`).

## Qué necesita cada máquina

| Casa | Runner |
|---|---|
| Cliente `ssh` (OpenSSH) y `fab` | `sshd`, `git`, `bwrap` (bubblewrap) y `fab` |
| Una clave SSH dedicada | Un usuario propio para la fab (no el tuyo de siempre) |
| El runner en `~/.ssh/config` y su clave de host en `known_hosts` | El agente (`claude` o `codex`) con su propia credencial (paso 5) |

`bwrap` debe poder crear espacios de nombres **sin ser root**. Si `fab runner check` declara `sandbox: none` (o un encargo termina en `RUNNER_REFUSED: not_confinable`), el runner no puede confinar y no ejecutará nada: arréglalo en el runner (en Ubuntu 24.04 puede estar restringido por AppArmor: `kernel.apparmor_restrict_unprivileged_userns`). Nunca hay vuelta a local.

## Paso 1 · Clave dedicada en casa

Una clave que solo sirva para este runner, para que revocarla no afecte a nada más:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/fab-runner-torre -C fab-casa
```

`fab` invoca `ssh -o BatchMode=yes`: **nunca pide contraseña**. Si la clave lleva passphrase, tiene que estar cargada en tu `ssh-agent` antes de lanzar el pool; si no, `ssh` falla y el encargo queda bloqueado con `RUNNER_UNREACHABLE`. La fab no guarda ni lee ninguna clave: solo conoce el alias.

## Paso 2 · Línea de `authorized_keys` en el runner

En el usuario del runner, `~/.ssh/authorized_keys`, **una sola línea** (el contenido de `fab-runner-torre.pub` va al final):

```
restrict,command="env PATH=/home/fab-runner/.local/bin:/usr/local/bin:/usr/bin:/bin /home/fab-runner/.local/bin/fab runner serve --root /home/fab-runner/fab-runner" ssh-ed25519 AAAA… fab-casa
```

- `restrict` quita terminal, reenvío de puertos, de agente y de X11.
- `command=` fuerza el único programa que esa clave puede arrancar. Quien robe la clave de casa **no obtiene una shell**: solo puede mandar encargos, que corren confinados y con el comando que construye el runner. `fab runner serve` ignora `SSH_ORIGINAL_COMMAND` y cualquier argumento que no sea `--root`.
- **El `PATH` va explícito.** `sshd` lanza el comando forzado con un entorno mínimo; si `claude` vive en `~/.local/bin` y no está en ese `PATH`, el encargo termina en `RUNNER_REFUSED: agent_missing`. Es lo que hace la prueba de T74g con su `ssh` falso.
- `--root` es el directorio de trabajo del runner (`cache/`, `jobs/`, y opcionalmente `runner.json` con `{ "maxJobs": 1 }`). Solo lo escribe `fab runner serve`. No hay base de datos en el runner.
- **No pongas credenciales en esta línea**: viajarían en el `argv` del proceso y cualquiera del runner las vería con `ps`. Para la clave del modelo, ver paso 5.

!!! note "Sin verificar en esta máquina"
    `restrict` (OpenSSH ≥ 7.2) y `command=` son comportamiento documentado de `sshd(8)`; la máquina de T74g no tiene `sshd`, así que esta línea **no se ha probado**. Pruébala al configurar: con la clave, `ssh torre true` no debe dar shell ni ejecutar `true`; debe arrancar `fab runner serve` y esperar un mensaje.

## Paso 3 · Alias en `~/.ssh/config` de casa

La fab guarda solo un **alias**, nunca `usuario@host`:

```
Host torre
    HostName 192.168.1.50
    User fab-runner
    Port 22
    IdentityFile ~/.ssh/fab-runner-torre
    IdentitiesOnly yes
```

El alias debe cumplir `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. `fab` añade por su cuenta, en cada sesión: `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ServerAliveInterval=15`, `ServerAliveCountMax=4`, `ClearAllForwardings=yes`, `ForwardAgent=no`, `ForwardX11=no`, `PermitLocalCommand=no`, `ControlPath=none`, `UpdateHostKeys=no` y `VerifyHostKeyDNS=no`; y solo hereda `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` y `SSH_AUTH_SOCK`. Estas opciones se comprobaron con `ssh -G` (OpenSSH 9.6).

## Paso 4 · Clave de host (a mano)

`fab` nunca acepta claves nuevas (`StrictHostKeyChecking=yes`, sin `accept-new`). La primera vez la añades tú, comprobando la huella **por otro canal** (en la consola del runner, no por la misma red):

```sh
# en el runner
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# en casa
ssh-keyscan -t ed25519 192.168.1.50 > /tmp/torre.key
ssh-keygen -lf /tmp/torre.key          # la huella debe coincidir con la del runner
cat /tmp/torre.key >> ~/.ssh/known_hosts
```

Si la clave del runner cambia (reinstalación, suplantación), `ssh` se niega y la activity se bloquea con `RUNNER_UNREACHABLE`. Verifica el motivo antes de borrar la entrada vieja.

## Paso 5 · Credencial del modelo en el runner (D10/P1)

**El runner usa la suya**, puesta por ti en esa máquina; nada viaja desde casa y la fab no guarda nada. Dos formas, a elegir:

1. **Iniciar sesión en el runner**: como el usuario del runner, `claude` (o `codex login`). La credencial queda en `~/.claude/.credentials.json` (o `~/.codex/auth.json`) y el sandbox la monta **en solo lectura**. Es la misma exposición que ya existe en casa.
2. **Clave de API propia del runner**, con su tope de gasto en el proveedor y revocable sin tocar la de casa. Ponla en un fichero `0600` del usuario del runner y cárgala desde un script en lugar de desde `authorized_keys`:

    ```sh
    #!/bin/sh
    # /home/fab-runner/serve.sh  (chmod 700; la clave en ~/.config/fab-runner/anthropic, chmod 600)
    export ANTHROPIC_API_KEY="$(cat /home/fab-runner/.config/fab-runner/anthropic)"
    export PATH=/home/fab-runner/.local/bin:/usr/local/bin:/usr/bin:/bin
    exec /home/fab-runner/.local/bin/fab runner serve --root /home/fab-runner/fab-runner
    ```

    y `command="/home/fab-runner/serve.sh"` en el paso 2. `fab runner serve` pasa al agente solo lo de su lista fija (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`; con `codex`, `OPENAI_API_KEY`) más una base mínima.

Si el runner **se ve comprometido** se pierde esa credencial, no la de casa: revócala y rótala allí.

## Paso 6 · Registrar y probar

```sh
fab runner add torre --ssh torre [--max-bundle-mb 512]
fab runner check torre          # abre sesión, hello, y no envía código
fab ws runner <workstream> torre
```

`check` muestra versión de protocolo, `fabSha`, sandbox y adaptadores **declarados por el runner, no verificados**. Compara `fabSha` con el de casa: dos versiones distintas de fab pueden construir argv distintos. Para quitarlo: `fab ws runner <ws> --none`, `fab runner disable torre` (los workstreams con él se bloquean con `RUNNER_DISABLED`) y `fab runner rm torre`.

## Inventario web y runner por rol

En `fab web --write`, abre **Configuración → Runners** para registrar, editar o dar de baja un runner. Nombre y tipo identifican la entrada. Los ajustes editables son el confinamiento local o el alias SSH y el límite de envío. En la CLI se editan con `fab runner update` y se pausan con `fab runner disable`. Para cambiar un alias o borrar un runner, retira primero las asignaciones del workstream y de sus perfiles vigentes. La edición y la baja esperan a que termine el trabajo vivo.

Un perfil v2 admite, por ejemplo, `"roles": { "implement": { "runner": "torre" } }`. Los roles sin runner propio heredan el del workstream. Guarda una copia desde **Perfiles**, revisa la procedencia y confirma la asignación. En la CLI usa `fab profile import <archivo>` y `fab ws profile <ws> <digest>`. El pool resuelve cada activity al reclamarla y conserva el runner del intento. Los gates se ejecutan en casa. Un runner ausente o pausado bloquea la activity que lo eligió según las reglas del change. Los adjuntos esperan un turno local confinado.

## Qué verás cuando algo falla

| Código | Qué pasó | Qué hace la fab |
|---|---|---|
| `RUNNER_NOT_FOUND` / `RUNNER_DISABLED` | Runner fuera del inventario o pausado | Bloquea la activity que lo seleccionó |
| `RUNNER_UNREACHABLE` | No conecta, clave de host cambiada/desconocida, clave rechazada | Bloquea la activity; no reintenta sola |
| `RUNNER_REFUSED: <código>` | `not_confinable`, `unknown_adapter`, `agent_missing`, versión de protocolo | Bloquea |
| `RUNNER_BUSY` | El runner está en `maxJobs` | Reencola sin gastar reintento |
| `RUNNER_LOST` | Corte de red, runner apagado, **o el runner no pudo sellar el resultado** | Falla el intento y reintenta (hasta 3) |
| `RUNNER_RESULT_REJECTED` | El bundle de vuelta no pasa la verificación | Bloquea; mira el runner |

Cualquier fallo deja el worktree de casa como estaba (se importa todo o nada). Nunca se pasa a local en silencio.

!!! tip "Un resultado que el runner no puede sellar bloquea la activity"
    Si el agente deja algo que el sellado rechaza (un `.git` anidado con commits, un `.gitmodules` symlink, un fichero de 80 MiB incompresible, un `.gitattributes` con `working-tree-encoding=UTF-16` sin BOM), el runner contesta `error result_rejected` y casa bloquea la activity con `RUNNER_RESULT_REJECTED`: es determinista, así que no se reintenta. Un runner anterior a este cambio sigue contestando `error internal`, que casa trata como `RUNNER_LOST` y reintenta; actualiza los dos lados a la vez.

## Qué se probó y qué no

- Probado (T74g): el protocolo completo, el confinamiento, el sellado ante lo que deja un agente hostil y el corte a mitad de encargo, con un `ssh` falso que ejecuta `fab runner serve` en local (informe `impl-t74gh.md`).
- **No probado: el transporte SSH real.** Ni `sshd`, ni `restrict`/`command=`, ni `known_hosts` reales, ni la caída de una conexión de verdad (`ServerAlive*`). Esta guía es la receta; la primera vez, recórrela con un encargo pequeño.
