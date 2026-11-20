# T42 — estabilizar el test de snapshots interrumpidos

## Resultado y alcance

[V] Implementación en `/home/orlando/Desktop/factory/sw-factory-t42`, rama `fix/t42-test-inestable`, base `2cd359464c528a8dfe0ac3d954bf725e75f52232`. Solo cambia `tests/agent.test.ts:102`. No cambia producción.

## Causa

[V] `src/agent/engine.ts:89` activa el timeout total antes de `realpath`, la apertura/adquisición de la sesión y sus escrituras (`:90-140`). La primera comprobación del bucle está en `:221`; solo tras obtener una respuesta se asignan y guardan los pendientes (`:228-235`). Si el plazo vence durante la preparación, la ejecución acaba con cero turnos, cero tools y `pending: []`; el catch guarda `status: failed` (`:308-321`).

[V] `src/agent/session.ts:99-118` rechaza llamadas sin resolver y pendientes, no cualquier sesión fallida. Reanudar una sesión sin llamadas pendientes es válido. El test antiguo suponía que 40 ms bastaban para llegar a la tool. Si no llegaba, su proveedor conservaba la respuesta `Hang`; la reanudación la consumía, encontraba una tool desconocida (no recibe `tools: [hang]`) y pedía otra respuesta. El proveedor falso agotado devuelve «Unexpected extra model call» (`tests/agent.test.ts:17`). El bucle consulta de nuevo al modelo tras un resultado de tool (`src/agent/engine.ts:242-243`, `:273`).

[V] Una reproducción instrumentada en copia temporal, con `timeoutMs: 1`, confirmó: `first.error.type = timeout`, `turns = 0`, `toolCalls = 0`, `provider.requests.length = 0`, snapshot `status = failed`, `pending = []`, sin mensajes de assistant. Luego falla exactamente con «Unexpected extra model call».

[I] La carga de máquina puede hacer que los 40 ms originales venzan en esa misma fase. No encontré evidencia de una carrera que permita pasar desde una tool abortada a la siguiente llamada de modelo: el catch relanza cuando la señal está abortada (`engine.ts:243`) y se comprueba de nuevo antes de retirar pendientes (`:259-262`). La corrección pertenece a la fixture.

## Reproducción y prueba

[V] Antes: 50 ejecuciones consecutivas del test original, **1 fallo y 49 aciertos**. Falló la iteración 1 con el mensaje original. Sin carga artificial y sin modificar el worktree. Logs: `/tmp/t42-before-{1..50}.log`.

[V] Confirmación causal: **1 ejecución, 1 fallo** en `/tmp/t42-repro-zm7cq9xu`, copiando únicamente `src/`, el archivo de test y enlazando `node_modules`; se bajó el plazo a 1 ms y se imprimieron resultado, número de peticiones y snapshot. Log: `/tmp/t42-provoked.log`.

[V] Después: 50 ejecuciones consecutivas del test corregido, **0 fallos y 50 aciertos**. Logs: `/tmp/t42-after-{1..50}.log`.

[V] `bun test tests/agent.test.ts`: **23 pass, 0 fail, 77 aserciones**.

[V] Mutación en la misma copia temporal: test corregido y eliminación únicamente de la guarda final de `SessionStore.load` (`session.ts:117`). **1 ejecución, 1 fallo**: se recibe un error `provider` en lugar de `session`. La aserción principal detecta la pérdida de la protección. Log: `/tmp/t42-mutant.log`. No se mutó producción en el worktree.

## Cambio

[V] `tests/agent.test.ts:104-113` usa un `AbortController` del test. `Hang` instala su listener y entonces aborta la señal externa; su entrada prueba que el motor ya guardó el pendiente. No hay plazo corto ni espera para alcanzar ese estado; queda el timeout general por defecto como límite de ejecución.

[V] `tests/agent.test.ts:114-122` exige fallo `aborted`, un turno y una tool, snapshot fallido con el ID pendiente exacto, mensaje de assistant correlacionado y ausencia de resultado de tool. La reanudación debe fallar como `session`, con cero turnos y cero tools; el proveedor recibe una sola petición y la fixture se ejecuta una sola vez. Es una ampliación del test existente, no un test nuevo. El rojo previo corresponde al test original; el reforzado se validó además con la mutación descrita.

## Otros tests sensibles al tiempo — sin corregir

[V] Barrido literal de todo `tests/` por `timeoutMs`, `setTimeout` y `Bun.sleep`; inventario completo más abajo. Las siguientes ubicaciones merecen revisión. La sensibilidad describe la condición temporal visible, **no afirma que se haya reproducido inestabilidad en ellas**.

| Ubicación | Dependencia temporal |
|---|---|
| `tests/agent.test.ts:89-90` | Deadline de 25 ms y retorno antes de 1000 ms; puede vencer antes de alcanzar el proveedor colgado. |
| `tests/agent.test.ts:171-177` | Script espera 20 ms antes de fallar frente a una mutación programada a 200 ms; espera que la tool haya empezado y no haya mutado. |
| `tests/agent.test.ts:183-186` | Timeout total de 50 ms debe alcanzar una tool y esperar su drenaje de 30 ms; mismo riesgo de preparación que T42. |
| `tests/agent-stream-idle.test.ts:63` | Abort externo a 10 ms frente al watchdog; se comprueba la razón exacta. |
| `tests/agent-stream-idle.test.ts:120-123` | Timeout total de 40 ms y exigencia de exactamente una llamada al proveedor: riesgo análogo de no llegar a él. |
| `tests/agent-providers.test.ts:435` | Cancelación de stream a 50 ms; puede cancelar antes de que haya stream. |
| `tests/router-jev.test.ts:84-100` | Deadline de 5 ms para fetch colgado; comprueba timeout y distingue aborto externo. |
| `tests/router-jev.test.ts:170` | Espera de 20 ms para comprobar ausencia de rechazos no manejados. |
| `tests/agent-yolo.test.ts:105-111` | Aborto a 50 ms, límite de retorno y timeout de agente a 100 ms. |
| `tests/update.test.ts:99-109` | Deadline de 40 ms; aborto de instalador a 30 ms frente a descendiente que escribe a 150 ms. |
| `tests/agent-mcp.test.ts:35-39` | Timeout MCP de 35 ms, incluido el descubrimiento previo de tools; exige llegar a la operación colgada. |
| `tests/agent-mcp.test.ts:109-113` | Timeout HTTP de 30 ms y recepción de cancelación posterior. |
| `tests/agent-fetch-url.test.ts:172-177` | Deadlines de 25 ms para cabeceras/cuerpo, servidor que responde a 200 ms. |
| `tests/live-claude.test.ts:102-105` | Abort de turno a 200 ms; solo comprueba fallo y duración. |
| `tests/agent-script-durable.test.ts:46-49` | Ventana entre salida parcial a 150 ms, consulta tras 230 ms y final 400 ms más tarde. |
| `tests/agent-script-durable.test.ts:157-160` | Espera de 50 ms para que haya salida persistida antes del cierre. |
| `tests/agent-script-durable.test.ts:176-180` | Script retiene un slot durante dos esperas de 150 ms; aserción a 50 ms. |
| `tests/agent-script-durable.test.ts:212-215` | Callback espera 150 ms mientras el host cambia su política; el resultado presupone ese orden. |

[V] Otros plazos pequeños del inventario no implican necesariamente una carrera: por ejemplo, los `timeoutMs: 100` de Jev con fetch inmediato son límites, y los retardos de 30–40 ms después de un aborto en pruebas de drenaje retrasan la resolución de una promesa que se espera explícitamente. Los bucles de sondeo con `Bun.sleep(2..10)` comprueban una condición y un límite mayor; no se clasifican automáticamente como esperas fijas defectuosas. Se deja el inventario para revisar esos casos sin confundirlos con fallos demostrados.

## Comandos y validación

```sh
for i in $(seq 50); do bun test tests/agent.test.ts -t 'interrupted tool' > /tmp/t42-before-$i.log 2>&1; done
# Tras el cambio:
for i in $(seq 50); do bun test tests/agent.test.ts -t 'interrupted tool' > /tmp/t42-after-$i.log 2>&1; done
bun test tests/agent.test.ts
bun run typecheck
bun test tests > /tmp/t42-suite.log 2>&1
rg -n 'timeoutMs|setTimeout|Bun.sleep' tests
# Reproducción instrumentada y mutación, por separado en la copia temporal:
bun test /tmp/t42-repro-zm7cq9xu/tests/agent.test.ts -t 'interrupted tool'
git diff --check
```

[V] `bun run typecheck`: salida 0. `git diff --check`: salida 0.

[V] Suite completa ejecutada **una sola vez al final**: salida 0; **1405 pass, 2 skip, 0 fail**, 7981 aserciones, 1407 tests en 138 archivos, 317,78 s. Los dos omitidos son las pruebas optativas con modelo Claude real y con issues reales. Log: `/tmp/t42-suite.log`.

[V] Commit local: `662f645` — `test(agente): interrumpir snapshots con una señal controlada`. Solo contiene el cambio de `tests/agent.test.ts`; el informe queda sin confirmar en el checkout principal, como indican las reglas del repo.

## Límites y omisiones

[V] No hice push, merge, escrituras en GitHub, stash ni lancé subagentes. No cambié `src/`, otros tests, dependencias, configuración, ni `task.json`: el cierre de la cola y la verificación independiente pertenecen al orquestador. No ejecuté agentes reales ni cargué credenciales. No hice una auditoría de todas las fuentes de tiempo posibles: el inventario cubre los tres patrones literales indicados, no aliases, relojes inyectados ni toda sintaxis de temporizadores. Los logs de `/tmp` son evidencia local transitoria.

[V] Grafo consultado en nivel Verify sobre el proyecto principal `home-orlando-Desktop-factory-sw-factory` (ready). El worktree T42 no estaba indexado por separado; los metadatos de generación/cobertura resultaron no disponibles. Por ello, las afirmaciones se apoyan en lectura directa del código del worktree y en las ejecuciones, no en una supuesta completitud del grafo.

## Inventario literal de temporizadores

[V] Salida del barrido antes del cambio; las líneas del propio `agent.test.ts` posteriores al test T42 se desplazan 14 líneas en el resultado final. Incluye plazos largos y valores de validación para que quede visible qué se descartó del listado principal.

```text
tests/agent-providers.test.ts:435:    setTimeout(() => controller.abort(new Error('User cancelled')), 50);
tests/agent-hooks.test.ts:80:  const work = f.run(); for (let i = 0; i < 500 && !await Bun.file(join(f.cwd, 'started')).exists(); i++) await Bun.sleep(2);
tests/agent-hooks.test.ts:83:  await Bun.sleep(1100); expect(await Bun.file(join(f.cwd, 'late')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'stop')).exists()).toBe(false);
tests/cli-output.test.ts:27:  const timer = setTimeout(killGroup, 10_000);
tests/cli-output.test.ts:30:    await Bun.sleep(100);
tests/sdk.test.ts:87:  const server = greeting(async () => { await Bun.sleep(60_050); return 'late'; });
tests/agent-stream-idle.test.ts:63:    const timer = setTimeout(() => parent.abort(reason), 10);
tests/agent-stream-idle.test.ts:70:    const result = await runCodingAgent({ cwd: f.root, prompt: 'go', provider: f.provider, tools: [probe], timeoutMs: 2500, onEvent: e => events.push(e) });
tests/agent-stream-idle.test.ts:87:    await Bun.sleep(200); expect(signals[0]?.aborted).toBe(false); // successful completion disarms the watchdog
tests/agent-stream-idle.test.ts:114:    const result = await runCodingAgent({ cwd: f.root, prompt: 'go', provider: f.provider, maxRecoveryAttempts: budget, timeoutMs: 2500 });
tests/agent-stream-idle.test.ts:122:  const result = await runCodingAgent({ cwd: f.root, prompt: 'go', provider: f.provider, timeoutMs: 40 });
tests/chat-input.test.ts:46:    await Bun.sleep(20); expect(submitted).toBe(false); input.write('\r');
tests/chat-input.test.ts:68:    io.work('Modelo'); await Bun.sleep(170); io.update({ ...io.controller.statusState, inputTokens: 42 });
tests/chat-input.test.ts:83:    void permission.then(() => settled = true); await Bun.sleep(15); expect(settled).toBe(false);
tests/chat.test.ts:202:    input.write('/status\n/exit\n'); input.end(); await Bun.sleep(5);
tests/chat.test.ts:214:    input.write('\x1b'); input.write('[Z'); await Bun.sleep(5);
tests/chat.test.ts:218:    const root = terminal.question('fab [spec/off] › '); input.write('\x0c'); await Bun.sleep(5);
tests/chat.test.ts:222:    input.write('\x1b'); input.end(); await Bun.sleep(60);
tests/router-core-select.test.ts:133:      timeoutMs: 2000,
tests/router-core-select.test.ts:141:  test('resolves in ~timeoutMs without hanging when provider never responds', async () => {
tests/router-core-select.test.ts:145:      timeoutMs: 200,
tests/router-core-select.test.ts:159:      timeoutMs: 2000,
tests/router-core-select.test.ts:177:        timeoutMs: 2000,
tests/agent-stream-input.test.ts:18:async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end) throw new Error('Wait timeout'); await Bun.sleep(4); } }
tests/agent-rpc.test.ts:21:  while (!check()) { if (Date.now() > deadline) throw new Error('RPC wait timeout'); await Bun.sleep(2); }
tests/agent-mission-control.test.ts:64:  while (!await check()) { if (Date.now() > deadline) throw new Error('Wait timeout'); await Bun.sleep(3); }
tests/agent-mission-control.test.ts:166:      return count === 0 ? calls(['Execute', { background: true, command: command("require('fs').writeFileSync('background-start','yes');setTimeout(()=>require('fs').writeFileSync('late-background','bad'),800);setTimeout(()=>{},5000)") }])
tests/agent-mission-control.test.ts:167:        : calls(['Execute', { command: command("require('fs').appendFileSync('foreground-count','x');setTimeout(()=>require('fs').writeFileSync('late-foreground','bad'),800);setTimeout(()=>{},5000)") }]);
tests/agent-mission-control.test.ts:184:    await Bun.sleep(900);
tests/agent-mission-control.test.ts:213:    await new Promise<void>(resolve => { signal.addEventListener('abort', () => setTimeout(resolve, 40), { once: true }); });
tests/agent-execute-background.test.ts:83:      await Bun.sleep(150);
tests/agent-execute-background.test.ts:280:          await Bun.sleep(500);
tests/agent-execute-background.test.ts:297:    await Bun.sleep(1500);
tests/t12-correcciones.test.ts:39:  await Bun.sleep(20); await t.cycle();
tests/agent-chatgpt.test.ts:131:    for (const d of ['Re', 'ad', 'y']) { await Bun.sleep(80); c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: d })}\n\n`)); }
tests/agent-chatgpt.test.ts:132:    await Bun.sleep(80); c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`)); c.close();
tests/script-runtime.test.ts:51:    const r = await runScript({ code: 'while (true) {}', tools: {}, timeoutMs: 1500 });
tests/script-runtime.test.ts:106:        await new Promise<void>(resolve => { const stop = () => setTimeout(resolve, 40); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
tests/script-runtime.test.ts:126:      onContent: async () => { await Bun.sleep(30); observerDone = true; } });
tests/connectors-intake.test.ts:134:    for (let n = 0; n < 200 && !existsSync(ready); n++) await Bun.sleep(5);
tests/agent-rpc-mcp.test.ts:36:async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('MCP RPC wait timed out'); await Bun.sleep(10); } }
tests/router-jev.test.ts:33:      timeoutMs: 100,
tests/router-jev.test.ts:55:      apiKey: 'test-key', model: 'jev-1.14.0', baseUrl: 'https://example.test/decision', timeoutMs: 100,
tests/router-jev.test.ts:68:      signal: new AbortController().signal, timeoutMs: 100,
tests/router-jev.test.ts:79:        apiKey: 'private-test-key', signal: new AbortController().signal, timeoutMs: 100, fetch: fetcher,
tests/router-jev.test.ts:86:      apiKey: 'private-test-key', timeoutMs: 5, signal: new AbortController().signal,
tests/router-jev.test.ts:96:      apiKey: 'private-test-key', timeoutMs: 1000, signal: abort.signal,
tests/router-jev.test.ts:108:      apiKey: credential, signal: new AbortController().signal, timeoutMs: 100,
tests/router-jev.test.ts:163:          timeoutMs: 100,
tests/router-jev.test.ts:170:      await new Promise(resolve => setTimeout(resolve, 20));
tests/router-jev.test.ts:183:      timeoutMs: 1000,
tests/agent-omni-integration.test.ts:221:      await Bun.sleep(2);
tests/live-claude.test.ts:102:      setTimeout(() => ac.abort(), 200);
tests/live-claude.test.ts:138:    const t1 = await claudeLive.run({ prompt: 'Recuerda la palabra clave ÁMBAR-7. Llama a la tool report con state awaiting, pidiendo un color.', cwd, attemptId: 'l1', confine, timeoutMs: 120_000 });
tests/live-claude.test.ts:140:    const t2 = await claudeLive.run({ sessionId: t1.sessionId, prompt: 'Rojo. ¿Cuál era la palabra clave? Llama a report con state done.', cwd, attemptId: 'l2', confine, timeoutMs: 120_000 });
tests/router-core-config.test.ts:70:      classifier: { kind: 'jev', model: 'jev-latest', baseUrl: 'https://example.test', timeoutMs: 2500 },
tests/router-core-config.test.ts:73:    expect(valid.classifier).toEqual({ kind: 'jev', model: 'jev-latest', baseUrl: 'https://example.test', timeoutMs: 2500 });
tests/router-core-config.test.ts:78:    for (const classifier of [null, [], { kind: 'other' }, { kind: 'jev', model: '' }, { kind: 'jev', baseUrl: '' }, { kind: 'jev', timeoutMs: 0 }]) {
tests/agent-script-durable.test.ts:19:async function until(check: () => boolean | Promise<boolean>, timeout = 4000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error('Wait timeout'); await Bun.sleep(4); } }
tests/agent-script-durable.test.ts:46:    if (!n++) return call('Script', { code: "text('first'); await new Promise(r=>setTimeout(r,150)); notify('working'); await new Promise(r=>setTimeout(r,400)); text('last'); return 7;" }, 'script-1');
tests/agent-script-durable.test.ts:47:    if (n === 2) { await Bun.sleep(230); return call('WaitForScript', { toolCallId: 'script-1', timeoutMs: 0 }); }
tests/agent-script-durable.test.ts:48:    if (n === 3) return call('WaitForScript', { toolCallId: 'script-1', timeoutMs: 2000 });
tests/agent-script-durable.test.ts:49:    if (n === 4) return call('WaitForScript', { toolCallId: 'script-1', timeoutMs: 0 });
tests/agent-script-durable.test.ts:64:    if (!n++) return call('Script', { code: "await new Promise(r=>setTimeout(r,150)); notify('progress'); await new Promise(r=>setTimeout(r,600)); text('finished'); return 'value';" }, 'notify-run');
tests/agent-script-durable.test.ts:82:    const f = await fixture(() => !n++ ? call('Script', { code: "text('partial'); await new Promise(r=>setTimeout(r,31000)); return 42;", ...(mode === 'await' ? { await: true } : {}) }, mode)
tests/agent-script-durable.test.ts:83:      : n === 2 && mode === 'normal' ? call('WaitForScript', { toolCallId: mode, timeoutMs: 5000 }) : done());
tests/agent-script-durable.test.ts:98:  for (let i = 0; i < 4; i++) m.start('r' + i, { code: 'await new Promise(r=>setTimeout(r,10000));', tools: {}, timeoutMs: 20000 });
tests/agent-script-durable.test.ts:108:  m.start('overflow', { code: "for(let i=0;i<80;i++) text('x'.repeat(100000)); for(let i=0;i<40;i++) notify('n'+i); return 42;", tools: {}, timeoutMs: 10000 });
tests/agent-script-durable.test.ts:122:  const f = await fixture(() => !n++ ? call('Script', { code: 'await new Promise(r=>setTimeout(r,500));' }, 'clamp') : n === 2 ? call('WaitForScript', { toolCallId: 'clamp', timeoutMs: 999999999 }) : done());
tests/agent-script-durable.test.ts:130:    if (!n++) return call('Script', { code: `return await tools.Execute({command:${JSON.stringify(command("require('fs').writeFileSync('started','yes');setTimeout(()=>require('fs').writeFileSync('late','bad'),600);setTimeout(()=>{},5000)"))}});` }, 'kill-run');
tests/agent-script-durable.test.ts:136:  await Bun.sleep(750); expect(await Bun.file(join(f.cwd, 'late')).exists()).toBe(false);
tests/agent-script-durable.test.ts:144:      if (n < 2) { const id = ++n; return call('Script', { code: id === 1 ? `await tools.Execute({command:${JSON.stringify(command("require('fs').writeFileSync('started1','yes');setTimeout(()=>require('fs').writeFileSync('late1','bad'),600);setTimeout(()=>{},5000)"))}});` : "await new Promise(r=>setTimeout(r,600)); await tools.Create({file_path:'late2',content:'bad'});" }, 'abort-' + id); }
tests/agent-script-durable.test.ts:150:    await Bun.sleep(750);
tests/agent-script-durable.test.ts:157:  const f = await fixture(async () => !n++ ? call('Script', { code: "text('persisted'); await new Promise(r=>setTimeout(r,10000));" }, 'persist') : (await Bun.sleep(50), done()));
tests/agent-script-durable.test.ts:167:  let resumedTurn = 0; f.options.sessionId = first.sessionId; f.options.provider.complete = async () => !resumedTurn++ ? call('WaitForScript', { toolCallId: 'persist', timeoutMs: 0 }) : done(); f.events.length = 0;
tests/agent-script-durable.test.ts:176:  const start = await runtime.dispatch('Script', { code: "await new Promise(r=>setTimeout(r,150)); const r=await tools.Read({file_path:'missing'}).catch(()=>null); await new Promise(r=>setTimeout(r,150)); return 42;" }, { id: 'slot', type: 'function', function: { name: 'Script', arguments: '{}' } }) as any;
tests/agent-script-durable.test.ts:179:  await Bun.sleep(50); expect(finished).toBe(false);
tests/agent-script-durable.test.ts:180:  expect(await runtime.dispatch('WaitForScript', { toolCallId: 'slot', timeoutMs: 3000 })).toMatchObject({ status: 'completed', result: { output: 42 } });
tests/agent-script-durable.test.ts:187:    if (n < 2) { const id = ++n; return call('Script', { code: id === 1 ? `await tools.Execute({command:${JSON.stringify(command("require('fs').writeFileSync('rpc-start1','yes');setTimeout(()=>require('fs').writeFileSync('rpc-late1','bad'),600);setTimeout(()=>{},5000)"))}});` : "await new Promise(r=>setTimeout(r,600)); await tools.Create({file_path:'rpc-late2',content:'bad'});" }, 'rpc-' + id); }
tests/agent-script-durable.test.ts:202:  await Bun.sleep(750); expect(await Bun.file(join(f.cwd, 'rpc-late1')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'rpc-late2')).exists()).toBe(false);
tests/agent-script-durable.test.ts:212:  await runtime.dispatch('Script', { code: "await new Promise(r=>setTimeout(r,150)); try { await tools.Execute({command:'echo denied'}); } catch(e) { text(String(e)); } try { await tools.Execute({command:'echo no',network:true}); } catch(e) { text(String(e)); } return 42;" }, { id: 'policy', type: 'function', function: { name: 'Script', arguments: '{}' } });
tests/agent-script-durable.test.ts:214:  const result = await runtime.dispatch('WaitForScript', { toolCallId: 'policy', timeoutMs: 2000 }) as any;
tests/agent-script-durable.test.ts:236:  await runtime.dispatch('Execute', { background: true, command: command("require('fs').writeFileSync('saved-start','yes');setTimeout(()=>require('fs').writeFileSync('saved-late','bad'),600);setTimeout(()=>{},5000)") });
tests/agent-script-durable.test.ts:239:  await Bun.sleep(750); expect(await Bun.file(join(f.cwd, 'saved-late')).exists()).toBe(false);
tests/agent-script-durable.test.ts:246:  m.start('combined', { code: "text('x'.repeat(3000000)); return 'y'.repeat(3000000);", tools: {}, timeoutMs: 10000 });
tests/agent-script-durable.test.ts:256:    entered(); await new Promise<void>(resolve => { c.signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true }); if (c.signal.aborted) resolve(); });
tests/agent-script-durable.test.ts:257:  }) }, timeoutMs: 5000 });
tests/agent-script-durable.test.ts:259:  m.start('other', { code: 'await new Promise(r=>setTimeout(r,2000));', tools: {}, timeoutMs: 5000 });
tests/agent-script-durable.test.ts:266:  const f = await fixture(() => ++n <= 5 ? call('Script', { code: 'await new Promise(r=>setTimeout(r,10000));' }, 'live-' + n) : done());
tests/agent-script-durable.test.ts:286:  release(true); await Bun.sleep(50);
tests/agent-script-durable.test.ts:294:    : n === 2 ? call('WaitForScript', { toolCallId: 'large', timeoutMs: 3000 }) : done());
tests/agent-script-durable.test.ts:310:  const writer = runtime.dispatch('Execute', { command: command("require('fs').writeFileSync('writer-start','yes');setTimeout(()=>{},3000)") }).catch(() => {});
tests/agent-script-durable.test.ts:317:  f.controller.abort(); await writer; await Bun.sleep(30);
tests/admission-report.test.ts:50:  await Bun.sleep(30); resident.lock.acquire(); await resident.effects.dispatch(); resident.lock.release(); // vence la espera de #2 y agota #1
tests/chat-parity-2.test.ts:160:    input.write('/pl'); await Bun.sleep(15); expect(text).toContain('marketplaces'); expect(text).toContain('no disponible');
tests/chat-parity-2.test.ts:164:    input.write('/pl'); await Bun.sleep(15); expect(text.slice(before)).not.toContain('marketplaces'); input.write('\r'); expect(await permission).toBe('/pl');
tests/chat-parity-2.test.ts:165:    const pasted = io.question('fab [auto/off] › '); input.write('\x1b[200~/skill Inspect\nsecond line\x1b[201~'); await Bun.sleep(15);
tests/agent-omni-provider.test.ts:20:const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
tests/agent-omni-provider.test.ts:77:      await new Promise<void>(resolve => setTimeout(resolve, 0));
tests/agent.test.ts:63:  const readTool = tool('ProbeRead', 'read', {}, [], async () => { running++; peak = Math.max(peak, running); events.push('read-start'); await Bun.sleep(10); running--; events.push('read-end'); return 'ok'; }, 'fixture');
tests/agent.test.ts:89:  const result = await runCodingAgent({ prompt: 'task', cwd, timeoutMs: 25, provider: { id: 'hanging', complete: async () => new Promise(() => {}) } });
tests/agent.test.ts:106:  const first = await runCodingAgent({ prompt: 'start', cwd, provider, autonomy: 'low', sessionDir, timeoutMs: 40, tools: [hang] });
tests/agent.test.ts:157:    await new Promise<void>(resolve => { const timer = setTimeout(() => { mutated = true; resolve(); }, 200);
tests/agent.test.ts:161:  const provider = model([turn('', [call('Script', { code: 'tools.Slow({}); await new Promise(r=>setTimeout(r,20)); throw new Error("stop");' })]), turn('complete')]);
tests/agent.test.ts:169:    await new Promise<void>(resolve => c.signal.addEventListener('abort', () => { setTimeout(() => { settled = true; resolve(); }, 30); }, { once: true }));
tests/agent.test.ts:171:  const result = await runCodingAgent({ prompt: 'cancel', cwd, provider: model([turn('', [call('Slow', {})])]), autonomy: 'low', tools: [slow], timeoutMs: 50 });
tests/agent-fetch-url.test.ts:61:    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: null }, { networkAccess: true }, { allowPrivate: true }]) {
tests/agent-fetch-url.test.ts:65:  expect(parseFetch({ url: s.url.href })).toMatchObject({ maxBytes: 256 * 1024, timeoutMs: 10000 });
tests/agent-fetch-url.test.ts:66:  expect(parseFetch({ url: s.url.href, maxBytes: 1048576, timeoutMs: 30000 }).maxBytes).toBe(1048576);
tests/agent-fetch-url.test.ts:158:  await Bun.sleep(5); expect(ac.signal.aborted).toBe(true);
tests/agent-fetch-url.test.ts:167:  const pending = f.runtime.dispatch('FetchUrl', { url: s.url.href, timeoutMs: 30000 });
tests/agent-fetch-url.test.ts:168:  await gotRequest; await Bun.sleep(10); const start = Date.now();
tests/agent-fetch-url.test.ts:171:  await Bun.sleep(20); expect(cancelled).toBe(true);
tests/agent-fetch-url.test.ts:172:  const silent = server(async () => { await Bun.sleep(200); return new Response('late'); });
tests/agent-fetch-url.test.ts:174:  await expect(g.runtime.dispatch('FetchUrl', { url: silent.url.href, timeoutMs: 25 })).rejects.toThrow('timeout');
tests/agent-fetch-url.test.ts:177:  await expect(h.runtime.dispatch('FetchUrl', { url: hung.url.href, timeoutMs: 25 })).rejects.toThrow('timeout');
tests/agent-fetch-url.test.ts:185:  await Bun.sleep(20); expect(cancelled).toBe(true);
tests/chat-render.test.ts:38:    ui.update(status); ui.work('Modelo'); await Bun.sleep(115);
tests/chat-render.test.ts:40:    ui.assistant('# Texto\n', true); const end = output.length; await Bun.sleep(120);
tests/chat-render.test.ts:44:    ui.work('tool'); ui.assistant('**sin ANSI**', true); await Bun.sleep(110);
tests/chat-render.test.ts:48:    await Bun.sleep(120); expect(output.length).toBe(closed);
tests/manifest.test.ts:136:    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
tests/agent-yolo.test.ts:22:  return { opts: { ...f, prompt: 'test', permissionMode: 'yolo' as const, timeoutMs: 4000,
tests/agent-yolo.test.ts:105:  setTimeout(() => controller.abort(), 50); await expect(work).rejects.toThrow('aborted');
tests/agent-yolo.test.ts:108:  expect(result.stdout).toBe('leader'); await Bun.sleep(400);
tests/agent-yolo.test.ts:110:  const r = options(f, [call('Execute', { command: 'sleep 60' })], { timeoutMs: 100 });
tests/update.test.ts:99:    const start = performance.now(); expect(await updateMain([], { ...f.context, timeoutMs: 40 })).toBe(1);
tests/update.test.ts:106:  const timer = setTimeout(() => controller.abort(new Error('stop owned updater')), 30);
tests/update.test.ts:109:    await Bun.sleep(200); expect(await Bun.file(marker).exists()).toBe(false);
tests/agent-mcp.test.ts:35:  const c = await context(), manager = new McpManager({ local: { ...config(), timeoutMs: 35 } }, c);
tests/agent-mcp.test.ts:39:    await Bun.sleep(250); expect(await Bun.file(join(c.cwd,'late.txt')).exists()).toBe(false);
tests/agent-mcp.test.ts:109:  const manager = new McpManager({remote:{url:server.url.href,readOnlyTools:['hang'],timeoutMs:30}},c);
tests/agent-mcp.test.ts:135:    if (req.method === 'DELETE') { deleted = true; controller.abort(new Error('Stopped during cleanup')); await Bun.sleep(20); return new Response(null, { status: 204 }); }
tests/agent-loop.test.ts:87:    const command = node("require('fs').writeFileSync('started','yes');setTimeout(()=>require('fs').writeFileSync('late','bad'),250);setTimeout(()=>{},3000)");
tests/agent-loop.test.ts:90:    await expect(work).rejects.toThrow(); await Bun.sleep(320);
tests/agent-loop.test.ts:99:  await until(() => Bun.file(join(f.cwd, 'count')).exists()); await Bun.sleep(50);
tests/agent-loop.test.ts:106:  const timer = setTimeout(() => { heartbeat = true; }, 0);
tests/agent-mcp-oauth.test.ts:207:      await Bun.sleep(20);
tests/agent-rpc-hooks.test.ts:20:async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('RPC hook test timed out'); await Bun.sleep(5); } }
tests/yolo-interfaces.test.ts:17:async function until(fn: () => boolean) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await Bun.sleep(2); } }
tests/agent-web-search.test.ts:459:      await Bun.sleep(1000);
tests/agent-web-search.test.ts:483:          setTimeout(() => {
tests/execute-network.test.ts:224:    const later = `setTimeout(()=>fetch(${JSON.stringify(e.server.url.href)}).catch(()=>{}),200)`;
tests/execute-network.test.ts:225:    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(later)}],{detached:true,stdio:'ignore'}).unref();require('fs').writeFileSync('started','1');${abort ? 'setTimeout(()=>{},2000)' : ''}`;
tests/execute-network.test.ts:230:        while (!await Bun.file(join(f.cwd, 'started')).exists()) { if (Date.now() > deadline) { controller.abort(); throw new Error('Sandboxed process never started'); } await Bun.sleep(2); }
tests/execute-network.test.ts:233:      const atReturn = e.requests(); await Bun.sleep(300); expect(e.requests()).toBe(atReturn);
tests/agent-mission.test.ts:146:    if (parent === 3) return calls(['Script', { code: 'tools.StartMissionRun({}); await new Promise(r=>setTimeout(r,200)); throw new Error("cancel nested mission");' }]);
tests/agent-mission.test.ts:180:    interactionMode: 'mission', sessionDir: paths.sessionDir, timeoutMs: 30_000 });
tests/agent-mission.test.ts:346:  await workerStarted; await Bun.sleep(300);
tests/agent-mission.test.ts:350:  await Bun.sleep(3500);
tests/agent-mission.test.ts:434:  const result = await runAgent({ ...paths, prompt: 'mission', provider, autonomy: 'high', interactionMode: 'mission', timeoutMs: 30_000 });
tests/agent-mission.test.ts:496:  const result = await runAgent({ ...paths, prompt: 'mission', provider: fixture.provider, permissionMode: 'yolo', interactionMode: 'mission', timeoutMs: 4000 });
tests/pool-leases.test.ts:61:    await Bun.sleep(20);
tests/pool-leases.test.ts:87:  await Bun.sleep(50);
tests/pool-leases.test.ts:184:    await Bun.sleep(60);
tests/pool-leases.test.ts:254:        await Bun.sleep(20);
tests/pool-leases.test.ts:393:      await Bun.sleep(20);
tests/pool-leases.test.ts:492:      await Bun.sleep(20);
tests/pool-leases.test.ts:510:    await Bun.sleep(30);
tests/pool-leases.test.ts:534:    await Bun.sleep(500);
tests/rpc-session-tools.test.ts:24:  while (!check()) { if (Date.now() >= deadline) throw new Error('RPC timeout'); await Bun.sleep(2); }
tests/agent-tasks.test.ts:56:      while (!childCwd) { if (Date.now() > deadline) throw new Error('Child did not start'); await Bun.sleep(2); }
tests/agent-tasks.test.ts:111:    const result = await runCodingAgent({ prompt: 'delegate', cwd, provider, permissionMode: 'yolo', timeoutMs: 4000 });
tests/helpers/loop-fetch.ts:27:  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture wait timeout'); await Bun.sleep(3); }
tests/agent-journal.test.ts:15:async function until(check: () => boolean | Promise<boolean>, max = 5000) { const end = Date.now() + max; while (!await check()) { if (Date.now() > end) throw new Error('Wait timeout'); await Bun.sleep(3); } }
tests/agent-journal.test.ts:121:  expect(result.error?.type).toBe('aborted'); await Bun.sleep(650); expect(await Bun.file(join(cwd, 'bg-late')).exists()).toBe(false);
```

<!-- FIN -->
