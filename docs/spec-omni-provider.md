# Spec: proveedor compuesto Omni para fab

Estado: **I0 y paquetes A/B/C implementados; integración I1/I2 local**. La
especificación original se conserva abajo; la configuración operativa está en
[omni-provider.md](omni-provider.md). No autoriza inferencia real. Base fab: `8321e259b0ed250d8ae1b91698a2d182af8b5168`
(`origin/main`), rama de esta spec: `spec/omni-provider`. Fecha: 2026-10-26.

## 1. Objetivo y límites

Añadir un `ModelProvider` compuesto, seleccionado como `modelId: "omni"`, que
encadene endpoints OpenAI Chat Completions del usuario mediante sus `customModels`.
Cada destino identifica modelo, cuenta y grupo de cuota. El router intenta primero
capacidad gratuita elegible y usa capacidad de pago **solo con opt-in explícito**.
Ante 429 o cuota agotada pasa a otra cuenta elegible, respetando cooldown y límites.
Nunca selecciona una entrada cuyo ToS efectivo sea `avoid` y exige tool calling
cuando el turno incluya herramientas. El navegador, OmniRoute y su demonio no son
necesarios: todo vive en el agente nativo de fab.

Éxito mínimo: con fixtures locales A=429, B=cuota agotada, C=respuesta válida con
`tool_calls`, fab devuelve íntegramente el turno C, registra decisiones sin secretos
y no hace peticiones a destinos prohibidos, sin capacidad o de pago no autorizado.

Fuera de alcance v1:

- Crear cuentas, obtener créditos, eludir límites por cuenta/organización o rotar IP.
  Varias keys del mismo proyecto/organización comparten grupo de cuota.
- Scraping, cookies web, OAuth de aplicaciones ajenas, endpoints privados o proveedores
  `tos: avoid`. No se cambia el harness legítimo `agy` ni otros workers externos.
- Nuevos protocolos Anthropic/Responses/Gemini nativo, JWT de service accounts,
  refresh OAuth o ampliación de `apiKeyHelper` para el adaptador genérico.
- Copiar o iniciar OmniRoute, su panel, proxy HTTP, base de datos o catálogo vivo.
- Descubrir cuotas reales, prometer tokens gratis, facturación exacta o garantías
  de gratuidad. `costTier` es una declaración operativa, no una tarifa verificada.
- Estado durable o coordinación entre procesos/máquinas. Se comparte estado en el
  proceso de una ejecución y sus roles/subagentes; el proveedor sigue aplicando su cuota.
- Hot reload, sondas de pago, recarga automática de saldo, CLI nuevo de gestión de keys.
- Composición de `omniRouter` con `autoRouter` o `modelRouting` en el mismo settings
  v1: se rechaza antes de red. Evita multiplicar reintentos y salidas de la lista
  controlada. El clasificador de tareas de `auto` seguirá siendo una alternativa;
  esta fase reutiliza sus primitivas, no crea otro clasificador.

La comprobación independiente de una credencial Google no forma parte de este
proveedor y no autoriza su uso para inferencia. No se incorpora esa credencial al repo.

## 2. Evidencia y reutilización concreta

Lectura del código local, no inferencias sobre versiones futuras:

| Pieza existente | Evidencia en fab | Uso previsto / carencia observada |
|---|---|---|
| Fallback estático | `src/agent/providers/router.ts:15-35,37-92` | Reutilizar `classifyProviderError` y `createRoutedProvider`; ampliar selección mediante hooks opcionales, conservando el camino estático actual. |
| Auto | `src/agent/providers/auto.ts:54-69,140-142,168-193` | Conservar cancelación, jitter, respeto a retryAfter y guardia después de delta. Extraer primitivas compartidas sin cambiar decisiones/clasificador/upgrade del modo auto existente. |
| Configuración/credenciales | `src/agent/settings.ts:20-46,51-57,104-147,234-370` | `customModels`, `${VARIABLE}`, alias y fábrica existentes; no añadir un segundo formato de keys. El loader hoy resuelve todas las keys con anticipación: ajustar solo el nuevo camino Omni para resolución diferida. |
| Adaptador genérico | `src/agent/provider.ts:50-69,126-164` | Reusar HTTP, SSE y validación atómica de tool calls. Actualmente desecha cuerpo/status estructurado y Retry-After del error; faltan metadatos seguros para distinguir cuota/429. |
| Errores/timeout | `src/agent/transport.ts:3-12,77-90` | `ProviderError` ya tiene `retryAfterMs`; parser existente recorta a 120 s. Omni debe preservar el plazo real del servidor, no usar ese recorte como permiso para reintentar antes. |
| Contexto de sesión | `src/agent/engine.ts:49-52`, `src/agent/tasks.ts:483` | Generalizar bind/fork por capacidad para Omni: fachada de eventos por sesión, estado de cuota compartido. |
| Construcción por roles | `src/agent/exec-flags.ts:208-258` | Una instancia de runtime Omni por ejecución, reutilizada por principal/spec/worker/validator; no crear estados independientes por cada llamada a la fábrica. |

OmniRoute local: `/home/orlando/Desktop/factory/ext/omniroute`, revisión
`866c46d2339175a1aafc5455b8c3949910b2bd30`, licencia MIT (`LICENSE`). Se toman ideas,
no código en este commit:

- `open-sse/config/freeTierCatalog.ts:14,40-58`: estados ToS y lista `avoid`.
- `open-sse/services/autoCombo/failClosedPool.ts:3-15`: pool vacío no debe ampliarse
  a todo el catálogo. `paidModelFilter.ts:21-43`: filtrar también selección, no solo listado.
- `open-sse/services/accountFallback/concurrencyLimit429.ts:1-40`: contención no es
  crédito agotado. `creditExhaustionSignals.ts:4-21`: separar cuota/crédito de 429 transitorio.
- `open-sse/services/accountFallback/cooldownCap.ts:12-25`: acotar backoff calculado.
  En fab ese tope no podrá acortar un Retry-After explícito del servidor.
- `open-sse/services/retryAfterJson.ts:92-130`: hints estructurados y procedencia;
  v1 empieza por Retry-After HTTP y códigos JSON reconocidos, sin copiar parsers propietarios.

Se leyó `/home/orlando/Desktop/factory/doc/droid-re/report-agy-omniroute.md`.
Su integración mediante proxy confirma una vía genérica ya existente, distinta
al router interno propuesto. Su smoke con cero cuentas no prueba que ningún
servicio sin key pueda funcionar. No se convierten sus cifras de cuota, listas
de modelos o apreciaciones ToS en garantías actuales de fab.
El MCP del grafo no tiene proyecto fab/OmniRoute entre los 19 listados; se usaron
graft y lectura localizada. No se afirma cobertura exhaustiva del grafo.

## 3. Configuración propuesta (todavía no aceptada por el parser)

```json
{
  "modelId": "omni",
  "customModels": [
    { "id": "free-a", "model": "tool-model", "provider": "generic-chat-completion-api", "baseUrl": "https://api-a.example.invalid/v1", "apiKey": "${FREE_A_KEY}" },
    { "id": "free-b", "model": "tool-model", "provider": "generic-chat-completion-api", "baseUrl": "https://api-b.example.invalid/v1", "apiKey": "${FREE_B_KEY}" },
    { "id": "paid-c", "model": "code-model", "provider": "generic-chat-completion-api", "baseUrl": "https://api-c.example.invalid/v1", "apiKey": "${PAID_C_KEY}" }
  ],
  "omniRouter": {
    "version": 1,
    "allowPaid": false,
    "maxAttempts": 4,
    "maxWaitMs": 15000,
    "requestTimeoutMs": 30000,
    "profiles": [
      { "modelId": "free-a", "providerId": "custom-a", "accountId": "account-a", "quotaGroup": "org-a", "costTier": "free", "tos": "ok", "acknowledgeTos": true, "supportsTools": true, "supportsImages": false, "contextWindow": 32768, "priority": 10 },
      { "modelId": "free-b", "providerId": "custom-b", "accountId": "account-b", "quotaGroup": "org-b", "costTier": "free", "tos": "ok", "acknowledgeTos": true, "supportsTools": true, "supportsImages": false, "contextWindow": 32768, "priority": 20 },
      { "modelId": "paid-c", "providerId": "custom-c", "accountId": "account-c", "quotaGroup": "org-c", "costTier": "paid", "tos": "ok", "acknowledgeTos": true, "supportsTools": true, "supportsImages": false, "contextWindow": 65536, "priority": 30 }
    ]
  }
}
```

Hosts/modelos son ejemplos ficticios, no recomendaciones ni endpoints que llamar.
`allowPaid: true` permite C después de agotar los gratuitos elegibles; no obliga
al usuario a copiar otra key ni habilita créditos en el proveedor.

Reglas de esquema:

1. Reservar `omni`; ningún custom model/alias puede sombrearlo. Alias existentes
   pueden apuntar al virtual una vez registrado. Entre 1 y 32 perfiles, IDs únicos,
   referencias normalizadas, sin ciclos/virtuales recursivos; campos desconocidos se rechazan.
2. Solo hojas `generic-chat-completion-api`; baseUrl explícita, sin userinfo,
   fragmento ni credenciales/query de autenticación. HTTPS remoto; HTTP de loopback
   permitido para modelos locales. Proxies opacos no prueban política de sus upstreams.
3. En perfiles Omni, key mediante la convención existente `${ENV_NAME}`; sin claves
   literales, sin archivo SA ni apiKeyHelper ignorado. Para servidores locales sin
   autenticación se admite apiKey ausente solo en loopback. Variables vacías/ausentes
   inhabilitan esa cuenta y no producen una petición con un placeholder como bearer.
4. Preservar validación/redacción antigua fuera de Omni. No resolver variables de
   perfiles excluidos/inhabilitados. No volcar settings ya expandidos ni URL con keys.
5. `maxAttempts` entero 1..8 (default 4), `maxWaitMs` 0..60000 (default 15000),
   `requestTimeoutMs` 1..120000 (default 30000); prioridad 0..1000; booleanos estrictos.
   El plazo absoluto de un turno es `inicio + maxWaitMs + maxAttempts*requestTimeoutMs`;
   respetar además el AbortSignal y cualquier deadline menor del engine.
6. `contextWindow` positivo declarado por destino; incluir presupuesto de salida
   y margen al comparar contexto. No truncar mensajes ni retirar tools para que encaje.
   Estimación del engine si está disponible; si falta, cálculo conservador local,
   nunca tratar un tamaño desconocido como capacidad infinita.

## 4. ToS, capacidad y gasto: orden obligatorio

Normalización pura primero; resolución de key y HTTP después. Política efectiva
combina catálogo revisado y configuración: **cualquier `avoid` gana**. No existe
`--force`, override, prioridad ni fallback de pago que lo desactive.

`catalog.ts` mantendrá una instantánea pequeña, atribuida y fechada de los IDs
marcados `avoid` en la revisión citada: duckduckgo-web, agy, antigravity, kiro,
amazon-q, muse-spark-web, t3-web, modal, nlpcloud, blackbox, completions, fireworks,
featherless-ai, friendliai, ai21, iflytek y coze. Canonicalizar alias conocidos.
Su clasificación es información del catálogo de referencia, no un dictamen legal.
No copiar presupuestos/modelos completos ni sincronizarlos por red al arrancar.

- `avoid`: excluido sin resolver secretos y sin petición, incluso si usuario marca `ok`.
- `ok`: requiere declaración explícita del operador; IDs/hosts desconocidos se
  consideran `unknown`, requieren `acknowledgeTos: true` y `tos: ok` revisado por él.
- `caution`, `ambiguous`, `unknown`: deshabilitados por defecto; aceptar `caution`
  o `ambiguous` solo con acknowledge explícito. `unknown` sin revisión queda fuera.
- Verificar identidad canónica y hosts conocidos: no convertir un proveedor
  conocido `avoid` en elegible cambiando el nombre del perfil o su alias.
  No prometer descubrir upstreams ocultos detrás de un proxy o detectar declaraciones falsas.

Elegibilidad por turno: habilitado, ToS admisible, cuenta/key disponible, grupo
sin cooldown/bloqueo, capacidad suficiente y tier autorizado. Si `request.tools`
no está vacío, `supportsTools` debe ser **true**; unknown/false no son fallback.
Con imágenes, exigir `supportsImages: true`. El metadato no prueba compatibilidad:
los contratos reales de tool calling se cubren con pruebas; probes reales son opt-in futuro.

Orden estable: gratuitos antes que pago autorizado; dentro del tier, preferir
supportsTools=true incluso en texto simple, luego prioridad ascendente e índice
de configuración. Nunca añadir un destino fuera de profiles cuando el pool quede vacío.
Un perfil `paid`/coste desconocido jamás recibe tráfico con allowPaid=false;
coste desconocido se rechaza en v1. La clasificación `free` no garantiza factura cero.

## 5. Máquina de intentos y estado

Estado en memoria por runtime de ejecución, compartido entre roles/subagentes:
`quotaGroup -> { cooldownUntil, disabledReason?, inFlight, failureCount }`.
`accountId` agrupa credenciales de la misma cuenta; un quotaGroup puede reunir
varias cuentas/keys que compartan proyecto/organización. Una key duplicada o
referencia ENV duplicada no crea cuota nueva. El operador debe identificar esos
vínculos: no se pueden deducir cuentas reales a partir de claves opacas.

Scheduler con adquisición síncrona atómica de lease, máximo un intento en vuelo
por quotaGroup. Liberar en finally, también en abort/timeout/error al decodificar.
Estado de selección y contadores de un turno son locales a esa invocación; nunca
un `currentModel` mutable compartido entre llamadas concurrentes.

1. Capturar configuración inmutable, señal y deadline. Calcular elegibles sin red.
2. Elegir grupo libre según orden; reservar lease y consumir un intento únicamente
   al invocar una hoja. Revalidar ToS, pago y cooldown justo antes de invocarla.
3. Delegar exactamente request/messages/tools/maxOutputTokens al adaptador existente;
   solo parámetros explícitos del destino pueden limitar la salida.
4. Al éxito devolver un ModelTurn ya validado; liberar lease; no ejecutar herramientas
   en el router. El engine es su único ejecutor después de la respuesta válida.
5. Al fallo sin salida comprometida, clasificar por metadatos seguros de la tabla;
   actualizar grupo y pasar al siguiente elegible. Esperar solo si no hay uno listo.
6. Esperar con sleep(ms, signal) inyectable; no superar maxWaitMs acumulado ni deadline.
   Si el reset real queda fuera del presupuesto, devolver agotado con retryAt seguro;
   no dormir minutos ni acortar el plazo para hacer otra petición.
7. Al agotar presupuesto/lista, error Omni final no retryable, marcado
   `routingHandled: true`. Los wrappers existentes no deben volver a intentar ese turno.

| Fallo observado, antes de publicar salida | Acción |
|---|---|
| 429 genérico | Cooldown del grupo; Retry-After si existe; si falta, backoff acotado con jitter. Otro grupo independiente puede atender. |
| Código estructurado de crédito/cuota (`insufficient_quota`, `billing_hard_limit_reached`, `credit_balance_too_low`) | Deshabilitar grupo hasta reset explícito conocido o recreación deliberada del runtime; no retry ciego con otra key del mismo grupo. |
| 402 | Crédito no disponible, misma política de grupo; no habilita pago adicional automáticamente. |
| 401 / código inequívoco de key inválida | Inhabilitar cuenta; continuar otra cuenta autorizada. Sin refresh/login automático. |
| 403/404 desconocido, safety/refusal, política, petición inválida 400/422 | Error final del turno, sin cambiar proveedor para sortear la denegación. Un mapeo de cuota debe estar reconocido por código/proveedor y probado, nunca inferirse de prosa. |
| 5xx, red, timeout por intento | Cooldown corto y siguiente elegible; sujeto al mismo presupuesto. Abort del usuario siempre final y distinto de timeout de intento. |
| Contexto excedido | Excluir ese modelo para este turno; otro solo si cabe todo el contexto. Sin compactación silenciosa. |
| Todos ocupados/en cooldown o solo paid no autorizado | Espera acotada o agotado claro; cero llamadas indebidas. |

`Retry-After` acepta segundos o fecha HTTP. Conservar el deadline completo, sin
recortarlo a 120 s; backoff local: base 500 ms, crecimiento 2^n, tope 8 s, jitter
como auto existente. Si hay hint de servidor, sumar solo jitter no negativo;
no reintentar ese grupo antes de él. Valores imposibles/desbordados inhabilitan
ese destino para el turno; no convertirlos en 0. La v1 no implementa parsers de
resets en lenguaje natural ni importa las excepciones específicas de OmniRoute.

Después del primer delta de texto no vacío o de publicar un resultado/tool batch:
**cero retry/fallback**. Usar callback interno aunque el caller no solicite deltas.
Un batch parcial de tools no se expone: el decoder lo descarta al fallar; nunca
se ejecuta dos veces. No concatenar respuestas de modelos distintos. Los errores
SSE/JSON inválidos sin código recuperable son finales, no una excusa para recorrer keys.

## 6. Contrato de módulos, fijado antes del trabajo paralelo

El integrador creará primero `src/agent/omni/contracts.ts` y sus firmas, sin cuerpos
sustitutivos que simulen éxito. Se congela en un commit base común para los tres.
Los tipos siguientes son **diseño**, no implementación en esta rama:

```ts
type Tos = 'ok' | 'caution' | 'ambiguous' | 'avoid' | 'unknown';
type FailureKind = 'rate_limit' | 'quota' | 'auth' | 'transient' | 'context' | 'fatal';
interface LeafDescriptor { id: string; provider: string; baseUrl?: string; model: string; }
interface Profile {
  modelId: string; providerId: string; accountId: string; quotaGroup: string;
  costTier: 'free' | 'paid'; tos: Tos; acknowledgeTos?: boolean;
  supportsTools: boolean; supportsImages: boolean; contextWindow: number; priority: number;
}
interface OmniConfig {
  version: 1; allowPaid: boolean; maxAttempts: number; maxWaitMs: number;
  requestTimeoutMs: number; profiles: readonly Profile[];
}
interface Needs { tools: boolean; images: boolean; estimatedInputTokens: number; maxOutputTokens: number; }
interface SafeFailure {
  kind: FailureKind; status?: number; code?: string; retryAt?: number;
  scope: 'turn' | 'model' | 'account' | 'group';
}
interface Lease { id: string; profile: Profile; }
interface AttemptContext { needs: Needs; attempted: ReadonlySet<string>; remainingAttempts: number; waitRemainingMs: number; deadline: number; }
type Choice = { kind: 'attempt'; lease: Lease } |
  { kind: 'wait'; until: number } | { kind: 'exhausted'; retryAt?: number };
interface Scheduler {
  select(ctx: AttemptContext): Choice; // reserva de forma síncrona
  settle(lease: Lease, result: { ok: true } | { ok: false; failure: SafeFailure }): void; // actualiza salud, no libera
  release(lease: Lease): void; // idempotente; para finally y abort
}
interface Clock { now(): number; random(): number; sleep(ms: number, signal: AbortSignal): Promise<void>; }
interface SafeHttpFailure { status: number; code?: string; retryAt?: number; contextLimit: boolean; }
interface OmniDependencies {
  scheduler: Scheduler; clock: Clock;
  resolveLeaf(modelId: string, signal: AbortSignal): Promise<ModelProvider>;
  estimateRequest(request: ModelRequest): Needs;
  emit?: (event: AgentEvent) => void;
}
interface OmniProvider extends ModelProvider {
  bindEvents(sink: ((event: AgentEvent) => void) | undefined): void;
  forSubagent(): OmniProvider;
}
interface RoutedAttempt {
  id: string; provider: ModelProvider;
  settle(result: { ok: true } | { ok: false; error: unknown; committed: boolean }): void;
  release(): void;
}
interface RoutedAttemptPlan {
  id: 'omni'; next(signal: AbortSignal): Promise<RoutedAttempt | undefined>;
  exhausted(): Error; // error final con retryable=false y routingHandled=true
}
```

Firmas públicas, imports entre paquetes y semántica congelada:

- A: `validateOmniConfig(raw: unknown, leaves: readonly LeafDescriptor[]): OmniConfig`;
  `eligibleProfiles(config: OmniConfig, needs: Needs): readonly Profile[]`;
  `effectiveTos(profile: Profile, endpoint: string): Tos`. Funciones puras; ninguna lee ENV/red.
- B: `createOmniScheduler(config: OmniConfig, deps: { clock: Clock; eligible: typeof eligibleProfiles }): Scheduler`;
  `classifyOmniFailure(error: unknown, now: number): SafeFailure`;
  `readHttpFailure(response: Response, now: number): Promise<SafeHttpFailure>`.
  `SafeHttpFailure` queda en contracts: status, código allowlisted, retryAt y contextLimit;
  jamás cuerpo, headers completos, key, URL autenticada o mensaje del upstream.
  Ese tipo neutral se define en transport.ts y contracts lo reexporta. ProviderError
  añade quinto argumento opcional `http?: SafeHttpFailure` y propiedad readonly http;
  B lee ese campo antes de acudir a classifyProviderError. Los cuatro argumentos
  previos mantienen su significado y la implementación legacy sigue funcionando.
- C: `createOmniProvider(config: OmniConfig, deps: OmniDependencies): OmniProvider`;
  `OmniDependencies` contiene scheduler, clock, `resolveLeaf(modelId, signal)` y emit
  de eventos seguros; `resolveLeaf` lo suministra el integrador, no hay imports de settings.
  `OmniProvider` extiende ModelProvider con bindEvents y forSubagent; la fachada hija
  conserva scheduler y borra el sink heredado hasta que su engine lo vincule.
- No ciclos: contracts solo importa tipos de `agent/types.ts` y reexporta el tipo HTTP de transport; A no importa B/C;
  B depende de contratos e inyección de A; C depende de A/B y contratos; settings
  construye y ensambla. Ningún paquete modifica contratos por su cuenta.

Reutilización de router/auto, responsabilidad del integrador:

- Añadir overload `createRoutedProvider(plan: RoutedAttemptPlan): ModelProvider`,
  que C adapta al Scheduler, conservando la firma antigua. Un solo bucle interno
  consume array estático o plan dinámico; sin plan mantiene su comportamiento.
  Ese bucle es el único dueño de los intentos; C no introduce otro bucle de retries.
- Extraer a `src/agent/providers/attempt-policy.ts` la guardia de salida/cancelación
  y cálculo de backoff compartidos con auto. Mantener defaults de auto y sus tests;
  Omni añade presupuesto y cooldown de cuenta mediante el plan, no un segundo clasificador.
  La observación interna de deltas aunque no haya callback se activa para el plan
  Omni; no cambiar inadvertidamente la semántica legacy sin callback.
- Añadir metadatos seguros opcionales a ProviderError conservando sus cuatro
  argumentos actuales; conectar readHttpFailure en el adaptador genérico. Leer
  como máximo 8 KiB y cancelar/liberar el body; sin incluir respuesta cruda en errores.
- Todo error final Omni lleva routingHandled y retryable=false; router/auto lo
  reconocen antes de heurísticas por mensajes. Rechazo de composición en settings
  más guardia de runtime para llamadas del SDK que construyan wrappers manualmente.
- Reusar validateTurn, SSE, withIdleResponse, ModelProvider y cancelación existentes.
  Las tools no se retiran o reformatean para aceptar un modelo incompatible.
- Cada complete crea su plan/contexto y mantiene el contador de envíos. next puede
  esperar disponibilidad o saltar credenciales ausentes, pero no hace HTTP. El
  provider devuelto contabiliza el envío al entrar a complete. Fallos de resolución
  inhabilitan la cuenta y como máximo se inspeccionan 32 perfiles: no hay bucle infinito.
  El router llama settle y release en finally; release es idempotente. C no usa un
  provider ficticio como primary ni escribe un segundo motor de failover.
- estimateRequest es inyectado por el integrador; se reutiliza la estimación del
  engine. Si se usa aproximación por bytes, se documenta y prueba su margen; no es
  garantía universal de tokenización. Imágenes sin estimación conocida se rechazan
  antes de red. Error real de contexto sigue excluyendo solo el modelo para el turno.

## 7. Reparto: tres paquetes SIN archivos compartidos

Cada implementador trabaja en su propio worktree desde el commit base de contratos.
No modifica archivos de otro paquete, ni agrega exports a índices comunes. Los
fixtures se crean dentro de su test o en su directorio exclusivo; no hay fixture
compartido mutable. Cambios de contrato se solicitan al integrador antes de continuar.

| Paquete / dueño | Archivos exclusivos | Tests exclusivos |
|---|---|---|
| A — **agy (Gemini)** | `src/agent/omni/config.ts`, `src/agent/omni/policy.ts`, `src/agent/omni/catalog.ts` | `tests/agent-omni-config.test.ts`, `tests/agent-omni-policy.test.ts` |
| B — **qoder** | `src/agent/omni/scheduler.ts`, `src/agent/omni/failures.ts`, `src/agent/providers/http-failure.ts` | `tests/agent-omni-scheduler.test.ts`, `tests/agent-omni-failures.test.ts` |
| C — **opencode** | `src/agent/providers/omni.ts`, `src/agent/omni/plan.ts` | `tests/agent-omni-provider.test.ts`, `tests/agent-omni-stream.test.ts` |

A entrega config/política y snapshot ToS atribuido. Casos: alias/proveedor avoid,
unknown/caution/ambiguous, falta de tools/imagen/contexto, paid opt-in, duplicados,
campos inválidos y referencias. No abre un servidor ni resuelve credenciales.

B entrega scheduler, cooldown/backoff y lector de metadatos HTTP. Casos: 429,
Retry-After segundos/fecha/largo/inválido, crédito vs rate limit, quotaGroup,
concurrencia/leases, presupuesto y abort de sleep. Reloj/random/sleep fake;
sin esperas reales ni peticiones a proveedores. Prueba JSON con secretos señuelo
para demostrar que no sobreviven en metadatos/errores.

C entrega la fachada ModelProvider y adaptación del plan al router compartido.
Casos: A 429 → B cuota → C tools; muestra salida única; no fallback tras delta,
batch parcial no ejecutado, agotado terminal y cancelación. Usa resolveLeaf y
scheduler fake para desarrollar antes de fusionar A/B; luego ejecuta contra los
módulos reales de A/B. No copia/reescribe el adaptador Chat Completions.

### Archivos compartidos reservados SOLO al integrador

- `src/agent/omni/contracts.ts`, `src/agent/providers/attempt-policy.ts`.
- `src/agent/settings.ts`: esquema/allowlist, lazy ENV para Omni, registro virtual,
  exclusión de composición y construcción sin defecto accidental hacia Ollama.
- `src/agent/provider.ts`, `src/agent/transport.ts`: metadatos y puente HTTP existente.
- `src/agent/providers/router.ts`, `src/agent/providers/auto.ts`: plan opcional,
  primitivas comunes y error delegado, sin alterar el comportamiento legado.
- `src/agent/types.ts`, `engine.ts`, `tasks.ts`, `exec-flags.ts`, `rpc.ts`,
  `registry.ts` (todos bajo `src/agent/`): eventos por sesión, fork, roles,
  listado del virtual y presupuesto. No hay sink mutable compartido entre sesiones.
- `src/cli.ts` y textos de ayuda; `README.md` y documentación de uso definitiva;
  manifiestos/lockfiles/índices comunes. No se prevén dependencias nuevas.
- `tests/agent-omni-integration.test.ts`, fixtures en `tests/fixtures/omni-integration/`,
  y cualquier cambio necesario a tests existentes. Ningún implementador los edita.

Secuencia: I0 fija contratos + hooks/primitivas backwards-compatible y prueba
regresión; A/B/C implementan en paralelo sin tocar esos archivos; I1 integra
A→B→C, registra config/proveedor y eventos; I2 ejecuta gates. Si I0 no está listo,
los implementadores usan dobles contractuales locales a sus tests, sin registrar
un proveedor de producción ni fingir que el parser acepta la configuración.

## 8. Criterios de aceptación verificables

Todos los tests de implementación serán offline: providers/ENV ficticios, reloj
inyectado, SSE en memoria o Bun.serve en loopback. Cero tokens reales, uso de la
credencial Google comprobada, llamadas al demonio de OmniRoute, Jira o GitHub.

| ID / test name estable | Prueba y resultado exigido | Dueño |
|---|---|---|
| TOS-01 `avoid is never contacted` | avoid primero, alias avoid y usuario intentando sobreescribirlo: 0 llamadas a resolver/HTTP; permitido sí se ejecuta. | A + I |
| CAP-01 `tools are a hard requirement` | peticiones con tools no alcanzan false/unknown; todos incapaces → agotado con 0 llamadas. Texto simple prioriza tools. | A/C |
| PAY-01 `paid requires opt in` | gratuitos agotados, pago disponible: 0 llamadas paid con false; exactamente una con true. Pool vacío no se amplía. | A/C |
| ROT-01 `429 then quota then tool turn` | A=429, B=cuota reconocida, C=tool_calls válido; orden A/B/C, un ModelTurn C y ningún tool ejecutado dentro del router. | C/I |
| QUOTA-01 `keys share quota group` | dos keys/modelos de un grupo agotado no se prueban como cuotas nuevas; un grupo independiente atiende. | B |
| TIME-01 `server reset is not shortened` | Retry-After 3600 s/fecha equivalente: no llamada temprana ni recorte a 120 s; otro grupo o agotado si maxWait=0. | B/I |
| TIME-02 `bounded retry and abort` | máximo 4 envíos por defecto; espera total ≤15000 ms fake; abort corta espera/intento, libera lease y no provoca fallback. | B/C |
| STREAM-01 `partial output never rotates` | delta no vacío y error: una llamada, cero fallback, incluso si caller no pasó callback; sin texto mezclado. | C |
| TOOL-01 `partial tools never execute` | SSE con batch incompleto o JSON de transporte inválido no llega al ejecutor; turno válido se ejecuta una sola vez por el engine. | C/I |
| ERR-01 `refusal does not rotate` | 403/safety/400 inválido no recorren cuentas; 401 inequívoco inhabilita su cuenta, otra autorizada sí puede servir. | B/C |
| CONC-01 `one lease per quota group` | dos turnos simultáneos nunca superan inFlight=1 por grupo; todos los finally liberan sin esperas colgadas. | B/C |
| SEC-01 `routing logs redact secrets` | señuelos en key, URL, body y headers no aparecen en errores/eventos/settings impresos; solo IDs/razón/plazo seguros. | B/I |
| COMPAT-01 `legacy routers keep behavior` | auto/estático sin Omni conservan fallback, upgrade, timeout y subagentes. Omni en cadena mixta se rechaza antes de red. | I |
| SESSION-01 `subagent routing stays scoped` | hijo recibe fachada/sink propios, comparte cooldown con padre/roles y conserva su sessionId en eventos. | C/I |

Comandos concretos **para la futura implementación**, no ejecutados como si ya existiera:

```sh
# A
bun test tests/agent-omni-config.test.ts tests/agent-omni-policy.test.ts
# B
bun test tests/agent-omni-scheduler.test.ts tests/agent-omni-failures.test.ts
# C
bun test tests/agent-omni-provider.test.ts tests/agent-omni-stream.test.ts
# Integrador: flujo end-to-end con fake HTTP y engine, sin servicios reales
bun test tests/agent-omni-integration.test.ts
bun test tests/agent-model-routing.test.ts tests/agent-auto-router.test.ts tests/agent-auto-router-subagent.test.ts tests/agent-stream-idle.test.ts tests/agent-providers.test.ts
bun test --max-concurrency=4
bunx tsc --noEmit
git diff --check
```

La prueba de integración construirá settings/ENV en un directorio temporal y un
servidor loopback con logs de llamadas. Invocará el CLI real con
`bun src/cli.ts exec "usa la herramienta fixture" --model omni --settings <fixture.json>`
y comprobará exit code, salida, número de intentos y ausencia de secretos. El
fixture de CLI usa un servidor MCP de loopback que ofrece una tool de solo lectura
y un contador, siguiendo los tests SDK/MCP existentes; no se invocan Execute ni
tools de escritura reales. El engine sigue siendo quien parsea argumentos de
las llamadas; un JSON de argumentos inválido nunca permite ejecutar la tool. No se añade un falso `--dry-run` no implementado al CLI existente.

Cierre I2: los tests nuevos y los legados pasan con 0 fallos, tsc y diff limpios,
se revisa la disjunción de propiedad de archivos y se documenta el estado en
memoria. Cualquier smoke real posterior requiere autorización propia y cuentas
configuradas; no es un gate de esta spec ni de las pruebas offline.

## 9. Resultado de esta tarea documental

Se entrega únicamente esta spec. No se añadieron runtime, registro, CLI, tests,
catálogos o dependencias; los bloques anteriores son contratos de trabajo futuros.
La clave y el token de la comprobación previa no están aquí ni forman parte del diseño.

## 10. Integración I1/I2

Se integran A `4733ab6`, B `2537b4f` y C `f80f20a` sobre I0 `7a16a50`.
Las decisiones de contrato, la restricción de hojas privadas, la estimación de
contexto y los comandos operativos están en [omni-provider.md](omni-provider.md).
El validador de A mantiene los campos opcionales de credenciales sin resolverlos;
B es el único clasificador; C consume sus decisiones a través del contrato.
Los resultados exactos de los gates y el SHA de integración se registran en el
informe de integración, fuera del repositorio. No se publica ni se hace push.
