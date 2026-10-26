# Router Omni del agente nativo

`fab exec --model omni --settings settings.json` selecciona entre hojas OpenAI
Chat Completions de `customModels`. Comparte cuotas y cooldowns entre el agente,
los roles de una misión y sus subagentes dentro de la ejecución. No necesita
OmniRoute ni un proxy y no añade un protocolo Gemini nativo.

Configuración mínima para un servidor local con tool calling:

```json
{
  "modelId": "omni",
  "customModels": [
    {
      "id": "local-tools",
      "model": "your-tool-model",
      "provider": "generic-chat-completion-api",
      "baseUrl": "http://127.0.0.1:11434/v1"
    }
  ],
  "omniRouter": {
    "version": 1,
    "profiles": [
      {
        "modelId": "local-tools",
        "providerId": "local",
        "accountId": "local-account",
        "quotaGroup": "local-quota",
        "costTier": "free",
        "tos": "ok",
        "acknowledgeTos": true,
        "supportsTools": true,
        "supportsImages": false,
        "contextWindow": 32768,
        "priority": 10
      }
    ]
  }
}
```

Para endpoints remotos, usar HTTPS y `"apiKey": "${YOUR_PROVIDER_KEY}"` en la
hoja; el valor se lee del entorno solo cuando se selecciona ese destino. Claves
literales, `apiKeyHelper`, `authFile`, credenciales en URL, query y fragmento se
rechazan. La ausencia de clave solo se permite en loopback. Una variable vacía
o ausente inhabilita su cuenta sin HTTP. El loader conserva la referencia ENV
en settings: nunca muestra una clave expandida del pool.

Añadir hojas/perfiles distintos para las cuentas del usuario. Dos cuentas que
compartan proyecto, organización o presupuesto deben declarar el mismo
`quotaGroup`. Las referencias ENV duplicadas deben declarar también el mismo
`accountId`; valores de clave iguales encontrados al resolver variables distintas
no habilitan tráfico con identidades de cuota contradictorias. Otro nombre o
clave de la misma cuenta no crea una cuota independiente.

Reglas de selección:

- Entre 1 y 32 perfiles, IDs de hoja únicos. Varias cuentas del mismo modelo upstream
  usan IDs de `customModels` diferentes. Los alias se normalizan antes de validar.
- `avoid` siempre queda excluido, también por alias/proveedor/host del catálogo
  estático. `ok`, `caution` y `ambiguous` requieren `acknowledgeTos: true`;
  `unknown` queda fuera. El catálogo es una referencia atribuida, no una garantía legal.
- Gratuitos primero; después modelos con tools, prioridad ascendente y orden de
  configuración. `paid` requiere `allowPaid: true`, cuyo valor por defecto es false.
  `free` es una declaración del operador y no garantiza factura cero.
- Con tools se exige `supportsTools: true`. La estimación usa el cálculo del engine
  multiplicado por cuatro (bytes serializados redondeados), más 256 tokens de
  margen y un token adicional del scheduler. Es conservadora y no garantiza
  tokenización exacta. Imágenes sin estimación conocida se rechazan antes de red,
  aunque se haya declarado soporte de imágenes.
- Las hojas incluidas en el pool son privadas: se selecciona `omni` o un alias de
  `omni`, también para roles de misión. No aparecen como destinos seleccionables
  por RPC/chat. Esto impide saltarse elegibilidad, cuotas y leases por selección
  directa de una hoja. Los modelos ajenos al pool conservan el uso habitual.
- `omniRouter` es incompatible con `autoRouter` y `modelRouting`, incluso si la
  sección está vacía. El rechazo ocurre antes de resolver claves o hacer HTTP.
  `omni` está reservado y sin configuración produce un error explícito.

Presupuestos opcionales en `omniRouter`:

| Campo | Predeterminado | Rango |
| --- | --- | --- |
| `maxAttempts` | 4 | 1..8 envíos por turno |
| `maxWaitMs` | 15000 | 0..60000 ms de espera acumulada |
| `requestTimeoutMs` | 30000 | 1..120000 ms totales por intento |
| `allowPaid` | false | booleano |

El timeout por intento es independiente del timeout de inactividad del stream.
Abortar desde el caller termina el turno, libera el lease y evita fallback. El
plazo de un turno es `maxWaitMs + maxAttempts * requestTimeoutMs`, sujeto además
al timeout del engine. No se reintenta tras publicar texto, tampoco si el caller
no pidió deltas. Las herramientas solo las ejecuta el engine tras validar el turno.

429 usa cooldown por grupo y conserva íntegro `Retry-After` (incluidas fechas y
plazos superiores a 120 s). Desbordamiento numérico excluye el destino del turno.
Cuota/crédito reconocidos inhabilitan el grupo durante el runtime; un
`Retry-After` genérico no demuestra recarga de crédito. 401 inhabilita su cuenta.
403/400 inválido y errores SSE/JSON sin señal recuperable son finales. Los errores
Omni finales llevan `routingHandled: true` y `retryable: false` para impedir que
wrappers legados repitan el turno. El pool vacío nunca se amplía.

Eventos `model_routed` contienen IDs, razón y `sessionId`, nunca claves, URL,
headers ni cuerpos del upstream. Cada engine tiene fachada/sink propios; los
hijos comparten salud de cuota y sus eventos reenviados llevan su `agentId`.
Por RPC se usa `fab_model_routed` con `from`, `to` y `reason`. Auto conserva su
payload de clasificador `decision`.

La salud es solo del proceso/runtime, sin persistencia ni coordinación entre
procesos. No hay refresh/login automático, descubrimiento de cuotas, sondas
reales o ampliación automática de gasto. Para usar la misma hoja directamente
fuera de Omni, usar otro settings sin `omniRouter`.

## Contratos de integración

`LeafDescriptor` admite `apiKey?`, `apiKeyHelper?` y `authFile?` para la validación
pura. `OmniDependencies.classify?` conecta el clasificador único de B;
`eligible?` permite revalidar la política de A. El default del plan también usa
B: se retiró el clasificador provisional de C. El conjunto `attempted` tiene
identidad estable durante el turno y contiene IDs de hojas, no nombres upstream.

`Scheduler` conserva su interfaz mínima síncrona; `waitAndSelect` y `diagnose`
son extensiones aditivas de B, no obligaciones nuevas para los dobles de C. El
plan consume `Choice.wait` para disponibilidad sin introducir otro motor de
reintentos. No se añade un flag de reset de crédito: v1 no lo deduce de headers.

La integración se valida offline con `tests/agent-omni-integration.test.ts`:
CLI real, HTTP/MCP en loopback, credenciales ficticias y reloj inyectado para
cooldowns. Los timeouts de transporte usan temporizadores cortos locales. Las
pruebas cubren ejecución única de herramientas, denegaciones, salida parcial,
roles, eventos de subagentes, límites, redacción y composición prohibida. No se
ha realizado inferencia contra servicios externos.
