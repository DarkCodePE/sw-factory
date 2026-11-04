# Implementación de la fase A del ADR-0008 (2026-11-02)

Contrato: `codesearch/plan-implementacion-adr-0008.md`, filas A1–A7. Sin dependencias nuevas, sin tocar `src/`, graft ni `ext/`, sin `git add/commit`.

## Qué hace cada fila y dónde vive

Las líneas son aproximadas (±3): la herramienta de lectura de este entorno elide cuerpos y no pude contarlas con exactitud. Para ubicar un símbolo basta `grep -n` con su nombre.

| Fila | Qué hace | Dónde |
|---|---|---|
| A1 | Retira M1: borrados `buildSeedIndex`, `extractSeeds`, `prioritize`, `STOP`, `MAX_SEED_FREQ`. `ask` ya no lee `wiring.json` ni antepone semillas. Test que comprueba que ya no se exportan. | `scripts/ideas/graft-lector.ts`; `tests/graft-lector.test.ts` (test «A1») |
| A2 | Subcomando `rg <patrón> [--fixed] [--in ruta]`: `rg -n --sort path` con cwd en el repo, mismo tope y spill (`bound`). Cabecera «N líneas en M archivos». No usa índice ni sidecar. `ask/skeleton/callers/grep` siguen igual, siempre con `--no-refresh`. | `rgReport` (~L76), rama `rg` de `main` (~L205) |
| A3 | `bound` acepta `head` (líneas de cabecera que siempre se conservan) y `rank` (las líneas de rango 0 entran antes de cortar). `grep`: conserva la cabecera de conteo. `skeleton`: prioriza los símbolos con `export` en el fuente (`exportedNames` + `exportRank`). `rg`: conserva su cabecera. El pie del truncado indica «k de n líneas». | `bound` (~L34), `exportedNames` (~L63), `exportRank` (~L70) |
| A4 | `measure <ruta> [--budget N]`: suma los bytes de `git ls-files -- ruta`, `tokens_medidos = ceil(bytes/4)`, decide `leer_entero` si `tokens ≤ presupuesto` (128 000 por defecto) o `bajar_nivel`. | `tokensOf`/`measureDecision` (~L84), rama `measure` (~L160) |
| A5 | Tipo `ProbeBudget {tipo_fuente, tokens_medidos, presupuesto_lectura, tope_consultas}` con `validateProbeBudget`. `session-init` crea el JSON de sesión; `--session <json>` cuenta consultas y bytes servidos con `chargeSession` (pura). Al superar el tope de consultas o `presupuesto_lectura × 4` bytes no sirve nada, sale con **código 5** y la sesión queda cortada (pegajosa). | `ProbeBudget`/`validateProbeBudget` (~L90), `chargeSession` (~L106), `main` |
| A6 | `lector-fab.ts` imprime la entrada MCP de graft (`command` absoluto, `args: ["mcp"]`, `readPaths` = `realpath` de node y raíz del paquete graft). Test de integración que ejecuta `graft --version` a través de `wrapMcpCommand` (con `--unshare-net`); se omite sin bwrap, graft o node. | `scripts/ideas/lector-fab.ts`; `tests/lector-fab.test.ts` |
| A7 | Tests por cambio y suites en verde (ver abajo). | `tests/graft-lector.test.ts` (9 tests), `tests/lector-fab.test.ts` (1 test) |

Códigos de salida del núcleo: 2 uso, 3 índice obsoleto (M4), 4 `init` falló, 5 sesión cortada.

## Independencia

Por el ajuste de alcance: el lector será un producto independiente de fab (de momento vive en sw-factory).

- **Núcleo** `scripts/ideas/graft-lector.ts`: solo importa `node:child_process`, `node:fs`, `node:os`, `node:path`. Depende únicamente de Bun/node, git, rg y graft. No importa nada de `src/`.
- **Adaptador de fab** `scripts/ideas/lector-fab.ts` (`mcp-config`) y `tests/lector-fab.test.ts` (usa `wrapMcpCommand` de `src/agent/mcp-sandbox.ts`): lo único acoplado a fab. El comando `mcp-config` ya no existe en el núcleo; se invoca con `bun scripts/ideas/lector-fab.ts`.
- **Guardia**: el test «Independencia» de `tests/graft-lector.test.ts` lee los imports del núcleo y falla si alguno apunta a `src/`, `../src` o a `lector-fab`. Es una regex sobre `from`/`import "…"`; no detecta `require` ni imports construidos dinámicamente.
- No se añadió el modo MCP del lector.

## Verificación

- `bunx tsc --noEmit`: sin salida, código 0 (tras mover A6).
- `bun test` (suite completa, tras mover A6): **965 pass, 0 fail**, 5 072 `expect()`, 95 archivos, 227 s. (Antes: 955 pass + 4 de graft-lector; ahora graft-lector tiene 9 y lector-fab 1, y A6 se ejecutó, no se omitió.)
- `bun test tests/graft-lector.test.ts tests/lector-fab.test.ts`: 10 pass, 0 fail.

## Ejemplos reales (repo `ext/opencode` @ `79469efc`, solo lectura, `--no-refresh` donde aplica)

### `measure`

```
measure .                              {"archivos":8642,"bytes":137978588,"tokens_medidos":34494647,"decision":"bajar_nivel"}
measure packages/core/src/session      {"archivos":52,"bytes":468228,"tokens_medidos":117057,"presupuesto_lectura":128000,"decision":"leer_entero"}
```

- `session/` da 117 057 tokens, que coincide con los «~117 k» del ADR.
- La raíz da **34,5 M tokens**, no los ~9,5 M del ADR. La diferencia no la investigué más allá de esto: `git ls-files` incluye todo lo versionado (8 183 archivos bajo `packages/`, 134,5 MB), no solo código fuente, y el ADR citaba 37,8 MB «de código». Hay que decidir si `measure` debe filtrar por extensión; hoy no lo hace.

### `rg` con tope y spill

`rg permission.asked --fixed --max-bytes 1500 --session s.json`:

```
"permission.asked" — 59 líneas en 44 archivos (rg; respeta .gitignore/.ignore)
./graft/packages/cli/src/acp/permission.md:3:- PermissionEvent · type · L24-L24 — type PermissionEvent = …
… (8 líneas más)
./packages/app/src/runtime/server/client.test.ts:56:    repoEvents.on("permission.asked", (event) => {
[truncado: 6451 bytes en total, 10 de 60 líneas; salida completa en …/scratchpad/lector-qtauC6/salida.txt]
```

- 59 líneas / 44 archivos coincide con `verdad.md` y con la medición anterior.
- Las primeras líneas son fichas de `graft/` (`measure graft` da 0 archivos, así que no están versionadas, pero `rg` las ve): `rg` respeta `.gitignore`/`.ignore`, y eso no la excluye. Es ruido a considerar.

### Sesión (A5)

`session-init --tipo-fuente repo --tokens 9500000 --tope 3`; con 5 llamadas `rg`: las dos primeras sirven (rc 0), la 3.ª y la 4.ª salen con `SESIÓN CORTADA: tope de consultas superado (3)` y **rc=5**. Estado final: `consultas: 5, bytes_servidos: 7010, cortada: "tope de consultas superado (3)"`.

Nota: la sesión ya traía 1 consulta (el ejemplo de `rg` anterior), por eso solo 2 de las 4 llamadas del bucle se sirvieron.

### `skeleton` con tope (A3)

`skeleton packages/core/src/session/compaction.ts --max-bytes 1800`: la vista previa muestra 9 de 56 líneas, empezando por los exports (`Settings`, `Editor`, `Trigger`, `Outcome`, `Interface`, `Service`, …) y deja las internas en el spill.

### `lector-fab.ts` (A6)

```json
{
  "graft": {
    "command": "/home/orlando/.nvm/versions/node/v22.22.1/bin/graft",
    "args": ["mcp"],
    "readPaths": [
      "/home/orlando/.nvm/versions/node/v22.22.1/bin/node",
      "/home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft"
    ]
  }
}
```

El test lo pasa por `wrapMcpCommand` (red desconectada, repo en solo lectura) y `graft --version` imprime una versión (graft 0.28.1 en esta máquina).

## Lo no verificado

- **Tiempos y costes**: no medí nada de latencia; no se afirma ninguna mejora de coste de la fase A.
- **A3 sobre `layer` y `node`**: el `skeleton` de graft no lista esas constantes (límite del índice, ya medido en T5); `exportRank` solo reordena lo que graft devuelve, no lo completa. Y `exportedNames` solo entiende TS/JS (`export …`): en Python/Go no prioriza nada (cae al orden original).
- **`measure` frente al ADR**: ver arriba (34,5 M frente a 9,5 M); falta decidir el filtro.
- **`mcp-config` dentro de fab real**: el test usa `wrapMcpCommand` y arranca `graft --version`; **no** arranqué `graft mcp` ni lo conecté a un agente de fab ni medí su protocolo.
- **Sesión**: el JSON de sesión no tiene bloqueo; dos procesos concurrentes pueden perder cuentas. Los bytes se cuentan sobre la salida ya acotada, no sobre lo que el modelo lee realmente.
- **Regla de `rg`**: no se omite el chequeo de frescura (M4) a propósito, porque `rg` lee el árbol vivo; no probé `rg` con `--in` a un archivo suelto ni con patrones regex complejos.
- **Número de líneas** de la tabla: aproximado (±3), ver arriba.
- Los artefactos brutos (salida de la suite completa) están en el scratchpad de la sesión, no versionados.
