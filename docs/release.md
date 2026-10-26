# CI/CD y distribución de FAB

El candidato de esta entrega es `0.1.0-rc.10`, paquete npm `@okuanb/fab`, dist-tag `next`. No reemplaza una versión estable. El estado real de publicación se comprueba en GitHub/npm; la presencia de estos workflows por sí sola no prueba una release.

## Contrato

La RC.8 añade permisos de red por llamada de Execute. Con la política auto,
high concede red cuando la herramienta la solicita; off/low/medium requieren
aprobación en TUI/RPC. `/network` y `--sandbox-network auto|ask|deny` permiten
configurar la política. El aislamiento de archivos se conserva; deny prevalece.
Véase [contrato y pruebas de red](design-execute-network-permissions.md).
La RC.9 añade `--yolo`: sin aprobaciones, shell y red del host para esta
invocación. `/yolo` muestra el estado; spec, btw, explore y validadores reducen
la autoridad. Véase [contrato YOLO](design-yolo-mode.md).
La RC.10 añade el router `auto` de modelos (clasificador local o Jev, rotación
ante errores, escalado y subagentes), aliases/routing de modelos, SDK, hooks en
chat/RPC y estado MCP.

1. Para iniciar un ciclo de release, se crea la rama `release/<versión>` y se ejecuta `node scripts/release/prepare.mjs <versión>`. El script sube `package.json` a la versión indicada, extrae los PRs fusionados desde el tag anterior (vía `gh pr list --state merged` o `git log --merges`) y añade la sección correspondiente en `docs/CHANGELOG.md`. Finalmente, imprime el título y cuerpo sugeridos para abrir la Pull Request de release hacia `main`.
2. `release-candidate-preflight.yml` se ejecuta al subir una rama `release/**`. Todos los jobs usan el mismo SHA explícito, sin credenciales Git persistidas. Linux ejecuta TypeScript y la suite completa con JUnit; se rechazan cero pruebas, fallos y omisiones.
3. Cuatro hosts compilan y ejecutan sus binarios nativos: Linux x64/ARM64 y macOS Intel/ARM64. Cada uno verifica YOLO con shell/red reales, efecto fuera del workspace, estado TUI y conflictos; también versión, ayuda, tarea Read → Edit → respuesta final con proveedor sintético local, respuestas de ambas herramientas, efecto real en archivo, tarea TUI seguida de `/rewind`, comandos TUI por pipe y listado MCP. Linux añade Script compilado, callback padre, sandbox requerido y timeout, tanto en el build como en el binario instalado por el wrapper npm o el instalador público. No se presenta macOS como equivalente al sandbox Linux.
4. `pack.mjs` reúne únicamente artefactos comprobados, genera manifest/checksums y un tarball npm con seis archivos explícitos. El paquete público no incluye el código fuente del workspace, pruebas, credenciales, capturas REA ni dependencias de desarrollo.
5. La cualificación instala ese tarball en homes/prefix nuevos y ejecuta su entrada `fab`. Antes de publicar se precarga únicamente el binario ya verificado en la caché, porque los assets de un draft GitHub no son públicos. Ese modo se declara en los recibos; no sustituye la prueba posterior de descarga real.
6. `seal.mjs` liga versión, SHA de origen, tarball, manifest, instalador, JUnit y cualificación de las cuatro plataformas. El artefacto `fab-sealed-<SHA>` conserva metadata y paquete; los binarios permanecen en sus artefactos nativos para evitar varias copias grandes.
7. Tras un preflight verde y la fusión de la PR de release a `main`, se crea el tag `v<versión>` de ese mismo commit. `protected-release.yml` busca un preflight exitoso de ese SHA y de una rama `release/**`; rechaza issues abiertos `release-blocker`. No acepta un run ID elegido por el caller ni reconstruye los binarios.
8. El publicador (`publish-github.mjs`) genera automáticamente las notas enriquecidas de la GitHub Release: sección extraída de `docs/CHANGELOG.md`, listado de PRs con enlaces y autores, enlace «Full Changelog: vA...vB» y comandos de instalación (npm e `install.sh`), preservando los recibos criptográficos del sello y notas de sandbox. Crea el draft con estas notas, descarga y compara cada asset con sus sumas SHA-256, y solo después lo hace público. npm publica el tarball sellado con provenance desde Actions, mediante OIDC configurado o token de bootstrap. No se publica desde la consola local.
9. Ambos canales se instalan después desde sus URLs públicas en los cuatro hosts. GitHub usa el script público; npm verifica el tarball del registro y ejecuta la instalación normal con postinstall. No hay caché precargada. Se comparan bytes instalados y se repiten las tareas/comandos.

Para backfill o regeneración de notas históricas de releases anteriores, se dispone de `node scripts/release/backfill-notes.mjs --dry-run` (modo lectura que imprime las notas calculadas para cada tag) y `--apply` (ejecutado por el integrador para aplicar los cambios a GitHub Releases existentes).

`packaging/npm/runtime.mjs` selecciona SO/arquitectura, limita descargas al tamaño del manifest y a redirecciones GitHub HTTPS, verifica SHA-256 antes de ejecutar y reemplaza la caché de forma atómica. La caché también se revalida al lanzar. Node >=22 ejecuta el wrapper; el binario contiene Bun. Windows nativo y musl quedan fuera; WSL utiliza Linux glibc. Git, bubblewrap y el proveedor del modelo se configuran por separado.

## Operación

```sh
# 1. Crear rama de release y preparar versión/changelog:
git checkout -b release/0.1.0-rc.11
node scripts/release/prepare.mjs 0.1.0-rc.11

# 2. Validar suites y empaquetado localmente:
bun install --frozen-lockfile
bun test
bunx --no-install tsc --noEmit -p .
FAB_TARGETS=bun-linux-x64 sh scripts/build.sh
node scripts/release/smoke.mjs dist/fab-linux-x64 dist/fab-linux-x64.receipt.json
node scripts/release/probe-update.mjs dist/fab-linux-x64 dist/fab-linux-x64.receipt.json

# 3. Commit y push de la rama candidata:
git add package.json docs/CHANGELOG.md
git commit -m "release: v0.1.0-rc.11"
git push origin release/0.1.0-rc.11
gh pr create --title "release: v0.1.0-rc.11" --body "<cuerpo emitido por prepare.mjs>"
gh run list -R DarkCodePE/sw-factory --workflow release-candidate-preflight.yml

# 4. Tras preflight verde y fusión a main:
git tag v0.1.0-rc.11 <SHA-verificado>
git push origin v0.1.0-rc.11
```

Una vez publicada y verificada la RC:

```sh
curl -fsSL https://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0-rc.10/install.sh |
  sh -s -- --version v0.1.0-rc.10
npm install -g @okuanb/fab@0.1.0-rc.10
fab --version
fab tui
```

GitHub `latest` excluye prereleases; npm `latest` se reserva para estables, aunque el tag heredado de FAB aún contiene una RC. El actualizador rechaza esa RC como estable; para una RC se utiliza el bootstrap con `--channel prerelease`, una versión explícita o npm `next`. El instalador de cada release queda fijado a esa versión y se publican también `latest.sh` y `prerelease.sh`, con hashes ligados al sello. `fab update` identifica el método de instalación y el canal de la versión instalada. Véase [instalación y actualización por canales](install-update.md). Una release estable exige que el SHA publicado sea exactamente `main`. No se fuerza un tag ni se modifica una versión npm publicada; una corrección posterior usa otra versión.

Para OIDC se configura el paquete npm con owner de GitHub `DarkCodePE`, repositorio `sw-factory`, workflow `protected-release.yml` y entorno `release`. npm requiere CLI >=11.5.1 y Node >=22.14 para trusted publishing ([documentación oficial](https://docs.npmjs.com/trusted-publishers/)). El primer paquete/scope necesita una identidad con permisos; las credenciales no se incluyen en el repositorio. `NPM_TOKEN`, si se utiliza para bootstrap, vive solo en GitHub Secrets y se entrega únicamente al paso de publicación.

## Referencias examinadas con Graft

Se construyeron grafos estructurales con `graft build --no-gitignore --no-ignore .`; se usaron `graft ask`/`skeleton` y lectura de líneas exactas. Los YAML de `.github` se leen como configuración: no se supone que el grafo de código los cubra. No se construyó la capa `--deep`. El servicio MCP codebase-memory no tiene índices para estos clones; esa limitación no se confunde con el grafo local Graft.

| Repo y commit observado | Evidencia | Patrón adoptado / diferencia |
| --- | --- | --- |
| Whip `1c5da05987d2869687dfc95fc9128ad2ad68e0f0` | `.github/workflows/publish-cli.yml:35`, `:87`, `:216`, `:284` | Admisión de fuente, builds nativos, candidatura con inventario y publicación de bytes ya probados. FAB no requiere su infraestructura R2 ni sus binarios de escritorio. |
| TrueForge `0a42995ea8bfb379ec7be4ed73c211708e58e40b` | `.github/workflows/release.yml:130`, `:183`, `:237`, `:250` | Propagar SHA tras versionado, inspeccionar payload antes del pack y publicar con provenance/OIDC. En FAB no hay un segundo commit de versionado dentro del workflow. |
| OpenHuman `7659c75dc5ef55ad87dba3fee84626046c288632` | `packages/npm/install.js:83`; `.github/workflows/release-packages.yml:196`, `:264` | Wrapper npm, binario/checksum y smoke del canal publicado. FAB exige sus pruebas; no adopta `continue-on-error` para dar por válida una distribución. |
| OpenCode `501b15af26915ba52682e20e220e7e137e89e92f` | `packages/cli/script/publish.ts:29`, `:41`, `:78` | Una versión común y launcher para binarios. OpenCode publica paquetes opcionales por plataforma; esta primera entrega FAB usa un paquete pequeño y assets GitHub sellados. Requiere acceso a GitHub durante la descarga inicial. |
| Warp `1e6ef379bc9f51257c4243e8c4396a046cede8af` | `.github/workflows/cut_new_release_candidate.yml:13`, `:34`; `.github/workflows/create_release.yml:84`; `script/create_release_tag_and_branch:39` | Separar candidato y canal de publicación; generar versiones/tag nuevos. FAB utiliza semver RC y no copia sus scripts de mutación de ramas o secretos de producto. |

Warp quedó indexado con 4195 archivos, 90781 nodos y 135344 aristas; OpenHuman con 4481 archivos, 59774 nodos y 88936 aristas. Son índices estructurales para consultas y no una certificación exhaustiva de su comportamiento.

Antigravity (`agy-ollama`, pane Herdr `w6:p4`) hizo una revisión de referencias en solo lectura. Un segundo revisor comprobó el pipeline propio sin modificar archivos. Sus opiniones no sustituyen los jobs reales ni los recibos públicos. La tarea Read/Edit usa un proveedor sintético para validar transporte, herramientas y efectos de forma determinista; no mide la calidad de un modelo comercial.

## Primera ejecución y portabilidad

El [preflight inicial](https://github.com/DarkCodePE/sw-factory/actions/runs/39151420453), SHA `1b8729cc5cf762f445b8f2ce4c810c34b4b0ada9`, pasó QA y ambos Linux, pero rechazó ambos macOS: el acceso seguro a archivos admitía únicamente Linux. No produjo un sello ni una publicación. La corrección conserva descriptores y rechazo de symlinks: Linux utiliza `/proc/self/fd`; Darwin utiliza `openat`/`mkdirat`/`renameat`/`unlinkat` mediante un módulo Node-API propio compilado en el host. Los journals TUI utilizan el mismo contrato. El build requiere C y headers de Node; Bun incluye el addon en el ejecutable. Las pruebas locales del addon sobre Linux no demuestran su ABI Darwin: esa comprobación corresponde a los dos runners macOS y a sus instalaciones posteriores.

El [preflight corregido](https://github.com/DarkCodePE/sw-factory/actions/runs/39153001782), SHA `17bd9441c6e227527ce50e3277998a6e806a7eb6`, pasó 202 pruebas sin omisiones y las cuatro plataformas. El [primer publicador](https://github.com/DarkCodePE/sw-factory/actions/runs/39153199668) se detuvo al extraer recibos duplicados de los artefactos nativos; no creó una release. La recolección ahora descarga cada artefacto en un directorio independiente y copia únicamente el binario, después de compararlo con el manifest sellado. Una regresión comprueba que los recibos no se sobrescriben. Se conserva el tag anterior `v0.1.0-rc.1`; el siguiente candidato usa versión/tag nuevos `0.1.0-rc.2`.

La RC.2 (`fb8a1464c600cc25658b1949ea5510be098f89d5`) pasó [preflight](https://github.com/DarkCodePE/sw-factory/actions/runs/39153347517) con 203 pruebas y fue [publicada en GitHub](https://github.com/DarkCodePE/sw-factory/actions/runs/39153532536); las cuatro instalaciones públicas Read/Edit/TUI/rewind pasaron. npm rechazó PUT con E404 y el paquete no quedó publicado. Una comprobación adicional del binario instalado bajo `/tmp` detectó que el tmpfs privado ocultaba el ejecutable al relanzar Script. La RC.3 restaura exclusivamente ese archivo mediante un bind de solo lectura. Las instalaciones npm precargadas y públicas Linux ahora deben ejecutar también el callback Script aislado y su timeout; el sello rechaza recibos sin esas pruebas. No se reutiliza el tag/artefacto público anterior.

## Nombre npm confirmado

La cuenta autenticada por el token aportado es `okuanb`; el usuario confirmó usar `@okuanb/fab`. La RC.4 cambia el nombre del paquete y genera una candidatura/versión nuevas. Conserva intactos los assets y tags anteriores. El token se configura únicamente en el entorno protegido `release`, secret `NPM_TOKEN`; el código no incluye su valor. El reintento de la RC.3 con credencial válida devolvió E403 porque npm exige 2FA o un token granular de publicación con bypass 2FA. El nombre correcto no elimina ese requisito: el registro solo se dará por verificado tras publicar y comprobar sus cuatro instalaciones públicas.

## Secret npm y cabeceras HTTP

Tras actualizar el secret en GitHub, el intento 3 de la RC.4 falló con `is not a legal HTTP header value`. La RC.5 normaliza únicamente espacios/CR/LF exteriores antes de crear NODE_AUTH_TOKEN y rechaza controles internos o caracteres no ASCII imprimibles con un error que no incluye la credencial. La forma normalizada también se registra en el enmascarado de GitHub. El valor original no se pasa a npm, y sin token se elimina el placeholder de setup-node para conservar OIDC. Tres pruebas reproducen la cabecera inválida y verifican normalización, rechazo sin filtraciones y fallback. El publicador Node conserva el guard de workflow protegido, SHA/tag, paquete sellado y provenance; no se publica desde la consola local ni se modifican releases anteriores. Esto no elimina requisitos de permisos o 2FA del registro.
