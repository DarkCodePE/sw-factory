# Reporte ola 3 — codex: gates deterministas

Estado: implementación y verificación terminadas en HEAD 845bba8. Contrato leído completo, incluidas reglas §2–4 y ficha 01. Tres commits locales, sin merge/push; límites de entorno y medición fuera del alcance indicados al cierre.
Propiedad: runner, pool/store/validators/CLI/manifest y tests asociados. No se modifican bench/ola3 ni scripts/e2e/ola3-*.

## Inspección y decisiones
- Base local: rama fab/research-ola3-codex; node_modules ya aparece como enlace no rastreado, se preserva.
- Tier Verify: indexado el worktree mediante MCP; búsquedas de runVerifier/processActivity/requestValidation/completeActivity/retryChange y cobertura consultada. Generación observada 2026-10-31T06:41:53Z, sin huecos registrados en archivos de implementación. Fuente leída para confirmar invariantes.
- runVerifier ya posee copia desechable, binds read-only, entorno filtrado y sandbox required sin red. Se extraerá una entrada argv reutilizable, preservando el contrato de misiones.
- Hoy requestValidation encola directamente los tres tipos LLM; gates tendrá rama propia y no ampliará VALIDATOR_KINDS. Sin --verify se conserva el flujo manual actual.
- Decisión mínima: con --verify, al completar implementación se encola gates; únicamente su pass habilita los tres validadores. Cada validación deberá mantener el HEAD verificado y un worktree limpio. Gate fail se bloquea para inbox y retry regresa a implementación.
- Timeout por paso fijo de 120 segundos; sin instalaciones ni dependencias nuevas. Salida completa redactada al manifest/logs existentes.

## Pruebas
Pendientes: tests focalizados, bun test, bunx tsc --noEmit y sesión CLI real toy-calc con fake.

## Pendiente
Implementación, comprobaciones, commits pequeños en español y evidencia de sesión real. Medición de sensibilidad/coste y LLM real corresponden a agy/coordinación y requieren presupuesto explícito; esta tarea verifica con fake.

## Avance de implementación
- src/gates.ts: runner secuencial obligatorio por argv, continúa tras fallos y timeout individual.
- src/agent/mission-evidence.ts y process.ts: entrada reutilizable runVerifierAt, sandbox previo conservado, captura completa incluso al abortar por timeout y limpieza de descendientes.
- src/store.ts: migraciones addColumn verify/verified_head, implementación encola gates, pass encola LLM atómicamente; fail bloquea y entra a inbox, retry invalida revisiones anteriores y vuelve a implementación.
- src/pool.ts: gates tiene rama propia sin prompts LLM, HEAD limpio antes/después; metadatos y log por paso redactados. Cada LLM exige HEAD verificado antes/después.
- src/cli.ts: --verify repetible; src/manifest.ts: veredicto para gates además de LLM.
- Revisión independiente solo lectura confirmó riesgos de reintento automático y resultados viejos; cubiertos con blocked inmediato e invalidación en retry.
- Primer typecheck detectó el ensanchamiento local de ActivityKind en REVIEWABLE_KINDS; corregido con comparación explícita sin tocar enums compartidos.

## Pruebas focalizadas (primera pasada)
`bun test tests/gates.test.ts`: 9 pass, 1 fail. Único fallo: el test asumía exit 127 para ejecutable inexistente; bwrap usa exit 1. Corregido el test para exigir exit != 0, que es el contrato.
Ya probados: control positivo de red host + conexión denegada en gate; copia desechable; dependencia read-only; entorno filtrado; >1 MiB sin truncar; timeout conserva salida y ejecuta siguiente paso; fail sin LLM e inbox; pass con HEAD enlazado; HEAD cambiado bloquea LLM; flujo sin verify; argv persistido.
Se preserva también --only cuando una solicitud manual necesita un gate nuevo mediante requested_validators en activities; gates automáticos tras implementación solicitan los tres.

## Entorno de sesión real
Primera sesión CLI (`/tmp/fab-ola3-real-y5gl5mcx`) falló correctamente por dependencia ausente: `/usr/bin/python3: No module named pytest`. No sirve como evidencia de sensibilidad al bug; se repite preparando ANTES una `.venv` ignorada en el worktree (paquetes pytest ya instalados copiados, sin red/instalaciones en gate), con `PATH=.venv/bin:$PATH`. HOME/PYTHONPATH permanecen filtrados. La fixture original ya contiene el bug `average([4]) == 2.0` (esperado 4). Para el caso sano se corrige únicamente calc.py y se hace commit en la rama de la fixture; fake solo emite STATUS/VERDICT y no implementa código.
Se restauró además el comportamiento previo de runVerifier de misiones (límite de salida y política de aborto originales); la nueva captura completa y timeout solo se aplican a runVerifierAt.

## Primera regresión completa y ajustes finales
`bun test`: **871 pass, 0 fail**, 4743 expect, 89 archivos, 233.35 s (861 de base + 10 nuevos). Se ampliaron después 3 pruebas para --only, aborto y log/manifest >1 MiB.
La prueba de salida grande al manifest destapó backtracking cuadrático en el patrón de URL de redact (un token de 1.1 MiB). Se añadió límite de palabra al inicio del esquema, conservando la redacción de URLs con credenciales; prueba directa del mismo token: 1,100,008 caracteres en 11 ms. Corrección dentro de src/manifest.ts, sin dependencia nueva.
La sesión real detectó que claimActivity trataba gates como implementación y dejaba change in_progress después del pass. Se excluye gates de esa transición, manteniendo implemented y habilitando validate/merge normales; nueva aserción sobre el estado final.
Las primeras fixtures bajo /tmp no exponían los metadatos comunes de Git del worktree al sandbox (tmpfs privado existente); se repitió bajo ~/.cache, donde el sandbox puede leer el git común. Se anotará como limitación heredada; no se amplía el sandbox ni el alcance de archivos de la tarea.
La .venv se preparó sin pip/red, copiando pytest/_pytest/pluggy/packaging/iniconfig y py.py ya instalados; pygments del sistema. Los gates no instalan nada.

## Revisión de invariantes de cierre
La segunda revisión independiente encontró dos rutas adicionales; se corrigieron antes de cerrar:
1. Con verify, retry de investigación bloqueada debe seguir siendo investigación (y conservar aprobación de especificación), no saltar a implementación. La conversión se limita a gates o validadores LLM; test nuevo.
2. Gate cancelado por aborto puede dejar change implemented sin LLM creados. El merge ahora exige gatePassed sobre HEAD actual en validationSummary/mergeBlocker, aunque el gate esté ausente o canceled; test nuevo. Esto también invalida el pass si la rama cambia después de validar.
La última suite focalizada previa a estos dos tests dio 31 pass, 0 fail (11.51 s); se repiten focalizada, regresión completa y typecheck con el árbol final.

## Archivos y líneas de la entrega
- `src/gates.ts:7`: ejecuta todos los pasos obligatorios y decide por exit/timeout/error.
- `src/agent/mission-evidence.ts:116,169`: entorno compartido y runVerifierAt sobre copia desechable, binds read-only y sandbox required sin red.
- `src/agent/process.ts:5,27`: observación completa de stdout/stderr, conservando los límites previos para los otros consumidores.
- `src/store.ts:291,329`: migraciones addColumn e INSERT con nombres; argv verificado al crear workstream.
- `src/store.ts:630,664,788,824`: gates conserva implemented; requests no saltan gates; pass y encolado de validadores son transaccionales.
- `src/store.ts:719,989`: summary ligado a HEAD y retry contextual sin saltar aprobación de investigación.
- `src/pool.ts:105`: rama propia gates; evidencia por paso, control de integridad, HEAD limpio antes/después; ningún prompt LLM para gates.
- `src/cli.ts:142,171`: --verify repetible, documentado en ayuda.
- `src/manifest.ts:18,80`: redacción eficiente de líneas largas y veredicto/aislamiento de gates; salida íntegra en logs por paso.
- `src/validators/publish.ts:29`: merge cerrado ante gates ausentes, cancelados o de otro HEAD.
- `tests/gates.test.ts:1`: 15 pruebas nuevas. **Tests existentes modificados: ninguno**; validators-pool conserva íntegros sus casos y su flujo sin --verify.

## Sesión real final: comandos y salida completos
Ejecutada con el CLI real y adaptador fake, sin llamadas a proveedores. Cada gate usa exactamente `python3 -m pytest -q`.
El caso roto y el sano son dos intentos del mismo change, unidos por `fab retry`; la corrección de fixture se prepara explícitamente porque fake no modifica código. No se modifican los tests de toy-calc.

```text
$ 'git' 'init' '-q' '-b' 'main' '/home/orlando/.cache/fab-ola3-real-2tnwc27e/toy-calc'

$ 'git' 'add' '.'

$ 'git' '-c' 'user.name=test' '-c' 'user.email=test@test' 'commit' '-qm' 'toy base con bug average'

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'ws' 'create' 'toy' '--repo' '/home/orlando/.cache/fab-ola3-real-2tnwc27e/toy-calc' '--goal' 'Verificar calc' '--agent' 'fake' '--verify' 'python3 -m pytest -q' '--no-change-approval' '--no-spec-approval'
workstream toy (752215a7) creado en draft; actívalo con: fab ws state toy active

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'ws' 'state' 'toy' 'active'
toy -> active

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'signal' 'add' 'toy' 'Comprobar caso roto' '--body' 'El test average falla'
signal acf21627 añadida

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'triage' '--all' 'toy'
signal acf21627 -> change b0154d5b (pending)

$ 'bun' '-e' 'import { Store } from "/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/store.ts"; import { ensureWorktree } from "/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/worktrees.ts"; const s = new Store(process.env.FABRICA_HOME+"/fabrica.db"); const c=s.listChanges("toy")[0]; console.log((await ensureWorktree(s.getWorkstream("toy").repo,process.env.FABRICA_HOME,c.id)).path); s.close();'
/home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b

$ 'python3' '-m' 'venv' '--without-pip' '--system-site-packages' '/home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b/.venv'

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'run' 'toy' '--once'
[w1-1497858] investigation "Comprobar caso roto" -> fake in /home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b
[w1-1497858] investigation done in 0s
[w1-1497858] implementation "Comprobar caso roto" -> fake in /home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b
[w1-1497858] implementation done in 0s
[w1-1497858] gates fail: b0154d5b-baa1-452d-b61a-830a41101f44

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'inbox' 'toy'

== 395bcb51  gates  change b0154d5b: Comprobar caso roto
blocked: GATES_FAIL
STEP 1: ["python3","-m","pytest","-q"]
exit=1 timeout=false
......F                                                                  [100%]
=================================== FAILURES ===================================
_____________________________ test_average_single ______________________________

    def test_average_single():
>       assert average([4]) == 4
E       assert 2.0 == 4
E        +  where 2.0 = average([4])

tests/test_calc.py:33: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_average_single - assert 2.0 == 4
 +  where 2.0 = average([4])
1 failed, 6 passed in 0.02s

-> fab retry b0154d5b | fab reject b0154d5b

MANIFEST FAIL: {"change": "b0154d5b-baa1-452d-b61a-830a41101f44", "head": "bf2c7fa1f61426403ac92597adf5cdad6bd9d05b", "status": "blocked", "gate": "fail", "LLM": 0, "steps": [{"argv": ["python3", "-m", "pytest", "-q"], "exitCode": 1, "timedOut": false, "durationMs": 245, "log": "395bcb51-9014-472f-af9b-427b8e9af00c.step-1.log"}]}
......F                                                                  [100%]
=================================== FAILURES ===================================
_____________________________ test_average_single ______________________________

    def test_average_single():
>       assert average([4]) == 4
E       assert 2.0 == 4
E        +  where 2.0 = average([4])

tests/test_calc.py:33: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_average_single - assert 2.0 == 4
 +  where 2.0 = average([4])
1 failed, 6 passed in 0.02s

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'retry' 'b0154d5b-baa1-452d-b61a-830a41101f44'
change b0154d5b: implementation re-encolada

$ 'git' 'add' 'calc.py'

$ 'git' '-c' 'user.name=test' '-c' 'user.email=test@test' 'commit' '-qm' 'fixture: corregir average'

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'run' 'toy' '--once'
[w1-1498634] implementation "Comprobar caso roto" -> fake in /home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b
[w1-1498634] implementation done in 0s
[w1-1498634] gates pass: b0154d5b-baa1-452d-b61a-830a41101f44 HEAD 6e0dc644a4fc8f0ad9315dc4b0dc0c9473c6ff22
[w1-1498634] code_review "Comprobar caso roto" -> fake in /home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b
[w1-1498634] change_review done in 0s
[w1-1498634] security_audit "Comprobar caso roto" -> fake in /home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b
[w1-1498634] change_review done in 0s
[w1-1498634] qa "Comprobar caso roto" -> fake in /home/orlando/.cache/fab-ola3-real-2tnwc27e/state/worktrees/b0154d5b
[w1-1498634] change_review done in 0s

$ 'bun' '/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts' 'validate' 'status' 'b0154d5b-baa1-452d-b61a-830a41101f44'
### Validación de fab change `b0154d5b` [APROBADO]

| Validador | Veredicto | Resumen |
| --- | --- | --- |
| `code_review` | **PASS** | Revision determinista fake |
| `security_audit` | **PASS** | Revision determinista fake |
| `qa` | **PASS** | Revision determinista fake |

MANIFEST PASS: {"change": "b0154d5b-baa1-452d-b61a-830a41101f44", "head": "6e0dc644a4fc8f0ad9315dc4b0dc0c9473c6ff22", "status": "implemented", "gate": "pass", "verifiedHead": "6e0dc644a4fc8f0ad9315dc4b0dc0c9473c6ff22", "LLM": 3, "steps": [{"argv": ["python3", "-m", "pytest", "-q"], "exitCode": 0, "timedOut": false, "durationMs": 258, "log": "97c4bae0-3767-4d85-a8ef-509d2c99d0fc.step-1.log"}]}
.......                                                                  [100%]
7 passed in 0.01s

EVIDENCIA: /home/orlando/.cache/fab-ola3-real-2tnwc27e
```

Script de reproducción (dependencias preparadas fuera del gate):

```python
import os, pathlib, shutil, subprocess, tempfile, json, importlib
root=pathlib.Path(tempfile.mkdtemp(prefix='fab-ola3-real-',dir='/home/orlando/.cache'))
source=pathlib.Path('/home/orlando/Desktop/factory/examples/toy-calc')
cli='/home/orlando/Desktop/factory/sw-factory-ola3-codex/src/cli.ts'
repo=root/'toy-calc'
shutil.copytree(source,repo,ignore=shutil.ignore_patterns('.git','__pycache__','.pytest_cache','.serena','graft'))
state=root/'state'
env=dict(os.environ,FABRICA_HOME=str(state),FABRICA_FAKE_STATUS='done\nVERDICT: pass\n\nRevision determinista fake')
def run(args,cwd=None):
    print('$ '+ ' '.join(repr(str(x)) for x in args),flush=True)
    p=subprocess.run([str(x) for x in args],cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    print(p.stdout,flush=True)
    if p.returncode: raise RuntimeError(p.returncode)
    return p.stdout
def fab(*args):return run(['bun',cli,*args])
run(['git','init','-q','-b','main',repo])
with (repo/'.gitignore').open('a') as f: f.write('\n.venv/\n')
run(['git','add','.'],repo)
run(['git','-c','user.name=test','-c','user.email=test@test','commit','-qm','toy base con bug average'],repo)
fab('ws','create','toy','--repo',str(repo),'--goal','Verificar calc','--agent','fake','--verify','python3 -m pytest -q','--no-change-approval','--no-spec-approval')
fab('ws','state','toy','active')
fab('signal','add','toy','Comprobar caso roto','--body','El test average falla')
fab('triage','--all','toy')
# Dependencias preparadas ANTES de los gates; no pip ni red en ejecución.
prep = 'import { Store } from "' + str(pathlib.Path(cli).parent/'store.ts') + '"; import { ensureWorktree } from "' + str(pathlib.Path(cli).parent/'worktrees.ts') + '"; const s = new Store(process.env.FABRICA_HOME+"/fabrica.db"); const c=s.listChanges("toy")[0]; console.log((await ensureWorktree(s.getWorkstream("toy").repo,process.env.FABRICA_HOME,c.id)).path); s.close();'
worktree = pathlib.Path(run(['bun','-e',prep]).strip().splitlines()[-1])
run(['python3','-m','venv','--without-pip','--system-site-packages',str(worktree/'.venv')])
site=worktree/'.venv/lib/python3.12/site-packages'
for name in ['pytest','_pytest','pluggy','packaging','iniconfig']:
    package=pathlib.Path(importlib.import_module(name).__file__).parent
    shutil.copytree(package,site/name,dirs_exist_ok=True)
shutil.copy2(importlib.import_module('py').__file__,site/'py.py')
env['PATH']='.venv/bin:'+os.environ['PATH']
fab('run','toy','--once')
fab('inbox','toy')
failed=list((state/'runs').glob('*/run.json'))[0]
m=json.loads(failed.read_text())
gate=next(a for a in m['activities'] if a['kind']=='gates')
assert m['status']=='blocked' and gate['verdict']=='fail' and not any(a['validator'] for a in m['activities'])
print('MANIFEST FAIL:',json.dumps({'change':m['changeId'],'head':m['head'],'status':m['status'],'gate':gate['verdict'],'LLM':0,'steps':gate['steps']}))
assert 'test_average_single' in (failed.parent/gate['steps'][0]['log']).read_text()
print((failed.parent/gate['steps'][0]['log']).read_text())
fab('retry',m['changeId'])
# El fake no implementa: preparar el arreglo de la fixture en su rama, sin tocar tests.
worktree=state/'worktrees'/m['changeId'][:8]
calc=worktree/'calc.py'
calc.write_text(calc.read_text().replace('(len(values) + 1)','len(values)'))
run(['git','add','calc.py'],worktree)
run(['git','-c','user.name=test','-c','user.email=test@test','commit','-qm','fixture: corregir average'],worktree)
fab('run','toy','--once')
fab('validate','status',m['changeId'])
m=json.loads(failed.read_text())
gate=[a for a in m['activities'] if a['kind']=='gates' and a['status']=='completed'][-1]
validators=[a for a in m['activities'] if a['validator'] and a['status']=='completed']
assert m['status']=='implemented' and gate['verdict']=='pass' and len(validators)==3
assert all(a['verifiedHead']==gate['verifiedHead'] and a['verdict']=='pass' for a in validators)
print('MANIFEST PASS:',json.dumps({'change':m['changeId'],'head':m['head'],'status':m['status'],'gate':gate['verdict'],'verifiedHead':gate['verifiedHead'],'LLM':len(validators),'steps':gate['steps']}))
print((failed.parent/gate['steps'][0]['log']).read_text())
print('EVIDENCIA:',root)
```

## Commits y comprobaciones de cierre
- `b5905a4` feat(gates): reutiliza verificación aislada por argv.
- `ece3ca0` feat(gates): exige pass del mismo HEAD antes de validar.
- `845bba8` test(gates): cubre aislamiento, fallos y continuidad del pipeline.
Todos en fab/research-ola3-codex, sin Co-Authored-By, merge ni push. Referencia MIT ESF citada en commits de implementación.
- `bun test tests/gates.test.ts tests/validators-pool.test.ts tests/manifest.test.ts`: **33 pass, 0 fail**, 164 expect, 7.11 s.
- `bunx tsc --noEmit`: **exit 0**, sin salida.
- `git diff --check`: **exit 0**, sin salida.
- CLI final: `/home/orlando/.cache/fab-ola3-real-2tnwc27e`, change `b0154d5b-baa1-452d-b61a-830a41101f44`; fail con 1 failed / 6 passed y 0 LLM; retry implementación; pass con 7 passed y 3 LLM fake, HEAD `6e0dc644a4fc8f0ad9315dc4b0dc0c9473c6ff22`; estado final implemented.
- Regresión completa final: **876 pass, 0 fail**, 4763 expect, 89 archivos, 228.62 s, exit 0 (`/tmp/ola3-bun-final.log`), sobre el árbol de HEAD 845bba8.

## Alcance y límites
- No se cambiaron bench/ola3/ ni scripts/e2e/ola3-*, ni dependencias/lockfiles, ni tests existentes.
- La medición 10+5 bugs, baseline QA LLM y sensibilidad/coste queda a cargo del banco paralelo de agy y requiere presupuesto/autoridad de coordinación; no se gastó en proveedores.
- Límite heredado documentado: si el repositorio común de un worktree está bajo /tmp, el tmpfs privado de missionGit oculta sus metadatos Git externos; selección de archivos/dependencias cae al fallback existente. Para la sesión reproducible se usó ~/.cache; no se amplió la superficie del sandbox ni se instalaron dependencias dentro de gates.
- Captura completa mantiene la salida en memoria antes de redactar/escribir (sin el truncamiento anterior); timeout fijo por paso de 120 s.
- `node_modules` continúa como enlace no rastreado preexistente; no se incluye en commits.


## Resultado final
Implementación entregada en `845bba8`, precedida por `b5905a4` y `ece3ca0`.

```text
$ bun test
 876 pass
 0 fail
 4763 expect() calls
Ran 876 tests across 89 files. [228.62s]
exit 0

$ bunx tsc --noEmit
(sin salida)
exit 0

$ git diff --check
(sin salida)
exit 0

$ git status --short
?? node_modules
```
El único no rastreado es el enlace preexistente. Revisión independiente final sin otros fallos materiales. Sin trabajo de implementación pendiente del contrato; sensibilidad/coste con LLM real y el límite heredado de Git externo en /tmp permanecen explícitamente documentados en alcance/límites.
