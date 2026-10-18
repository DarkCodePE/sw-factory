# CI/CD y distribución de FAB

La primera versión de prueba es `0.1.0-rc.1`, paquete npm `@darkcodepe/fab`, dist-tag `next`. No reemplaza una versión estable. El estado real de publicación se comprueba en GitHub/npm; la presencia de estos workflows por sí sola no prueba una release.

## Contrato

1. `release-candidate-preflight.yml` se ejecuta al subir una rama `release/**`. Todos los jobs usan el mismo SHA explícito, sin credenciales Git persistidas. Linux ejecuta TypeScript y la suite completa con JUnit; se rechazan cero pruebas, fallos y omisiones.
2. Cuatro hosts compilan y ejecutan sus binarios nativos: Linux x64/ARM64 y macOS Intel/ARM64. Cada uno verifica versión, ayuda, tarea Read → Edit → respuesta final con proveedor sintético local, efecto real en archivo, comandos TUI por pipe y listado MCP. Linux añade Script compilado, callback padre, sandbox requerido y timeout. No se presenta macOS como equivalente al sandbox Linux.
3. `pack.mjs` reúne únicamente artefactos comprobados, genera manifest/checksums y un tarball npm con seis archivos explícitos. El paquete público no incluye el código fuente del workspace, pruebas, credenciales, capturas REA ni dependencias de desarrollo.
4. La cualificación instala ese tarball en homes/prefix nuevos y ejecuta su entrada `fab`. Antes de publicar se precarga únicamente el binario ya verificado en la caché, porque los assets de un draft GitHub no son públicos. Ese modo se declara en los recibos; no sustituye la prueba posterior de descarga real.
5. `seal.mjs` liga versión, SHA de origen, tarball, manifest, instalador, JUnit y cualificación de las cuatro plataformas. El artefacto `fab-sealed-<SHA>` conserva metadata y paquete; los binarios permanecen en sus artefactos nativos para evitar varias copias grandes.
6. Tras un preflight verde, se crea el tag de ese mismo commit. `protected-release.yml` busca un preflight exitoso de ese SHA y de una rama `release/**`; rechaza issues abiertos `release-blocker`. No acepta un run ID elegido por el caller ni reconstruye los binarios.
7. El publicador crea un draft, descarga y compara cada asset, y solo después lo hace público. Un reintento puede completar un draft del mismo SHA; no sobrescribe bytes públicos. npm publica el tarball sellado con provenance desde Actions, mediante OIDC configurado o token de bootstrap. No se publica desde la consola local.
8. Ambos canales se instalan después desde sus URLs públicas en los cuatro hosts. GitHub usa el script público; npm verifica el tarball del registro y ejecuta la instalación normal con postinstall. No hay caché precargada. Se comparan bytes instalados y se repiten las tareas/comandos.

`packaging/npm/runtime.mjs` selecciona SO/arquitectura, limita descargas al tamaño del manifest y a redirecciones GitHub HTTPS, verifica SHA-256 antes de ejecutar y reemplaza la caché de forma atómica. La caché también se revalida al lanzar. Node >=22 ejecuta el wrapper; el binario contiene Bun. Windows nativo y musl quedan fuera; WSL utiliza Linux glibc. Git, bubblewrap y el proveedor del modelo se configuran por separado.

## Operación

```sh
# Ejecutar desde el checkout de la versión:
bun install --frozen-lockfile
bun test
bunx --no-install tsc --noEmit -p .
FAB_TARGETS=bun-linux-x64 sh scripts/build.sh
node scripts/release/smoke.mjs dist/fab-linux-x64

# Subir el candidato y consultar su ejecución:
git push origin HEAD:release/0.1.0-rc.1
gh run list -R DarkCodePE/sw-factory --workflow release-candidate-preflight.yml
# Solo tras preflight verde sobre el SHA exacto:
git tag v0.1.0-rc.1 <SHA-verificado>
git push origin v0.1.0-rc.1
```

Una vez publicada y verificada la RC:

```sh
curl -fsSL https://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0-rc.1/install.sh |
  sh -s -- --version v0.1.0-rc.1
npm install -g @darkcodepe/fab@0.1.0-rc.1
fab --version
fab tui
```

GitHub `latest` y npm `latest` son canales estables; para una RC se usa la versión explícita o npm `next`. Una release estable exige que el SHA publicado sea exactamente `main`. No se fuerza un tag ni se modifica una versión npm publicada; una corrección posterior usa otra versión.

Para OIDC se configura el paquete npm con owner `DarkCodePE`, repositorio `sw-factory`, workflow `protected-release.yml` y entorno `release`. npm requiere CLI >=11.5.1 y Node >=22.14 para trusted publishing ([documentación oficial](https://docs.npmjs.com/trusted-publishers/)). El primer paquete/scope necesita una identidad con permisos; las credenciales no se incluyen en el repositorio. `NPM_TOKEN`, si se utiliza para bootstrap, vive solo en GitHub Secrets y se entrega únicamente al paso de publicación.

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
