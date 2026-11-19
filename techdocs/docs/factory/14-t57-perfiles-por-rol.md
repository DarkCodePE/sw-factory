# 14 · T57 · Perfiles por rol

El perfil v2 permite elegir el adaptador y el modelo de un rol. El pool los resuelve por intento, antes de lanzar el agente, y registra el resultado. Cada cambio de configuración produce un digest SHA-256 nuevo.

## Esquema v2

Ejecuta `fab profile export --out perfil.json` para obtener el perfil por defecto. Conserva las plantillas de `worker` y `validators`, cambia `schemaVersion` a `2` y añade las opciones de ejecución que necesites.

```json
{
  "schemaVersion": 2,
  "harness": "claude",
  "model": "sonnet",
  "roles": {
    "investigate": { "model": "haiku" },
    "implement": { "model": "sonnet" },
    "code_review": { "harness": "codex", "model": "gpt-6.1-sol" },
    "security_audit": { "harness": "codex" },
    "qa": {}
  }
}
```

`roles`, cada entrada y sus campos `harness` y `model` son opcionales. `harness` debe nombrar un adaptador conocido. El modelo acepta de 1 a 128 caracteres entre letras y dígitos ASCII y los signos `._:/@-`, con un primer carácter alfanumérico. Cualquier adaptador que reciba un modelo debe admitirlo. El adaptador asociado a un modelo de rol es su `harness` o, si falta, el del perfil.

`fab profile import perfil.json` devuelve el digest. Con `fab profile inspect <digest>` se ven los roles configurados. El perfil se elige al crear un workstream con `--profile <digest>`. La exportación por defecto sigue siendo v1 y los perfiles v1 mantienen su digest y su comportamiento de lanzamiento.

| Rol | Activity |
|---|---|
| `investigate` | `investigation` |
| `implement` | `implementation` |
| `code_review`, `security_audit`, `qa` | Validación con ese nombre |
| Sin rol | `steward` hereda la configuración general. Los gates y la revisión humana carecen de lanzamiento de agente. |

## Resolución por intento

El adaptador se toma de `fab run --agent`, de `roles.<rol>.harness` en v2 o del workstream, por ese orden. En v2 el modelo del rol tiene prioridad si el adaptador resuelto coincide con el adaptador asociado a ese modelo. Le sigue `profile.model` si el adaptador resuelto coincide con `profile.harness`. Si ninguno aplica, se usa el modelo por defecto del adaptador.

En la tabla, `m0` es el modelo de primer nivel de Claude.

| Perfil o configuración del rol | Adaptador del workstream | `--agent` | Adaptador resuelto | Modelo pedido |
|---|---|---|---|---|
| v1 con `model` de identidad | claude | — | claude | Por defecto |
| v2 con `m0`, sin roles | claude | — | claude | `m0` |
| v2 con `m0`, sin roles | codex | — | codex | Por defecto |
| v2 con `implement.model = m1` | claude | — | claude | `m1` |
| v2 con `code_review = { harness: codex, model: g }` | claude | — | codex | `g` |
| v2, rol `qa` sin entrada, con `m0` | claude | — | claude | `m0` |
| v2 con `code_review = { harness: codex, model: g }` | claude | fake | fake | Por defecto |
| v2 con `qa.harness = codex` y `m0` | claude | — | codex | Por defecto |

El pool comprueba el pin del adaptador inicial al arrancar y el de cada adaptador adicional la primera vez que lo resuelve. Un pin discrepante bloquea la activity con `AGENT_BINARY_MISMATCH`, salvo aceptación explícita con `--accept-agent-binaries`. En un change de canal, un adaptador que carece de confinamiento bloquea la activity con `CHANNEL_NOT_CONFINABLE`. Al lanzar Claude confinado con un modelo elegido, el sandbox omite `ANTHROPIC_MODEL` del entorno del host.

`activities.agent` y `activities.model` registran el adaptador y el modelo pedido. La metadata por activity usa `adapter` y `model`, y `fab show <change>` muestra los valores presentes. `model = NULL` representa el valor por defecto en intentos registrados. Las activities anteriores a T57 pueden tener ambos campos en `NULL`.

## Sesiones vivas

`fab run --live` busca el backend vivo del adaptador resuelto. Investigación e implementación pueden abrir una sesión si existe ese backend. Los validadores siguen ejecutándose en un disparo. El turno pasa el modelo resuelto al backend y lo fija en `adm_sessions.model` antes de lanzar.

Para reanudar una sesión lanzada deben coincidir el backend, el directorio de trabajo, el modelo y el digest del perfil. Un perfil v1 sigue resolviendo `model = NULL`, compatible con las sesiones v1 anteriores a T57. Si cambia el modelo o el digest y sigue habiendo un backend vivo, el pool marca la sesión anterior como perdida, registra el motivo en un evento y abre una generación con el prompt reconstruido y las respuestas humanas existentes. Se aplica el tope de generaciones de la rama viva.

| Implementación | Responsabilidad |
|---|---|
| `src/profile.ts` | Valida el esquema, identifica el rol y resuelve adaptador y modelo. |
| `src/pool.ts` | Verifica el adaptador, aplica el confinamiento y registra la procedencia. |
| `src/live/turn.ts`, `src/admission/sessions.ts` | Fijan la identidad de sesión y controlan la reanudación y las generaciones. |
| `src/live/claude.ts`, `src/sandbox/confine.ts` | Entregan a Claude el modelo del turno y su configuración MCP en el sandbox. |
