# Script runtime

Implementación propia desde el contrato documentado en el informe 08; sin código
del runtime propietario. Requiere Bun. Importar `runScript` y los tipos desde
`./src/script-runtime/index.ts`.

```ts
const result = await runScript({
  code: 'const answer = await tools.math.double({ n: 21 }); text(answer); return answer;',
  tools: { 'math.double': async input => (input as { n: number }).n * 2 },
  timeoutMs: 5_000,
});
```

Cada llamada inicia `worker.ts` mediante `Bun.spawn`, con entorno vacío salvo
`PATH`, sin cargar `.env`, y termina/recolecta ese proceso al obtener resultado,
error o timeout. Protocolo NDJSON v1, máximo **10 MiB UTF-8 por frame** sin contar
el salto de línea. Handshake `ready`, una única `evaluate`, `evaluation_started`,
`tool_call`/`tool_result`, `content`, `notify` y terminal `result`/`error`.
Los límites viajan al worker como argumento de arranque, no como variables de entorno.

El programa es JavaScript. Se evalúa como script, conservando el valor de su
última expresión; si contiene la palabra `await` o `return` se envuelve en una
IIFE async (también si aparece en comentarios/strings). En ese caso se usa
`return` para devolver un valor. Sin valor retornado, `output` es `null`. Los datos del
puente/resultados deben ser serializables como JSON. Cada tool recibe un argumento;
sin argumento recibe `null`. Las claves con puntos crean rutas anidadas bajo
`tools`; se rechazan rutas vacías, conflictivas y segmentos de prototipo.
Una ruta desconocida lanza `TypeError: Unknown Script tool binding`.

El contexto `node:vm` nuevo expone `tools`, `text(value)`, `image(mime, base64)`,
`notify(string)`, console capturado y `setTimeout(callback, delay, ...args)`.
`text` y console convierten valores no string a JSON. Console admite log/info/
warn/error/debug/dir/trace y agrega contenido de texto, sin escribir logs al
stdout del protocolo. Imágenes: PNG/JPEG, base64 canónico no vacío. Las
notificaciones deben contener texto no vacío. Timers: 0..86.400.000 ms.
Se espera la finalización del programa, tools y timers registrados antes del
resultado. Los errores de tools rechazan su Promise y pueden capturarse en el script.

Defaults: resultado **5 MiB**, contenido + notificaciones **5 MiB**, **64** tools
pendientes, **64** timers y **30 s** de timeout total, incluido arranque y tools.
`limits` puede reducir resultado/salida/pendientes hasta cero; no puede superar
esos tres máximos. `maxTimers` admite cualquier entero seguro no negativo.
Resultado se mide como JSON UTF-8; salida como suma del JSON UTF-8 de cada
objeto de contenido y cada string de notificación (incluyendo estructura/escape,
para que las emisiones vacías también consuman presupuesto).
El resultado tiene presupuesto independiente.
Superar un presupuesto produce `output_limit`; exceso de tools/timers o fallo
de protocolo produce `runtime`; excepciones del script producen `program`.
El timeout mata al hijo incluso ante bucles síncronos y devuelve `timeout`.
Se conserva contenido/notificaciones válidos anteriores al fallo.

No se entregan objetos o funciones del host al programa: las APIs se construyen
en su realm, los datos se serializan y el bootstrap se elimina antes de evaluar.
No están disponibles require/process/Bun/fetch/WebAssembly/SharedArrayBuffer/
Atomics; se impiden imports y generación dinámica de código. `globalThis` es el
del contexto. `node:vm` y un proceso separado **no constituyen aislamiento del SO**:
no se añaden namespaces/seccomp ni un límite de memoria del proceso. Las tools
del padre son capacidades explícitas y deben aplicar su política de permisos;
una tool ya despachada no se puede cancelar mediante esta API al vencer el timeout.
