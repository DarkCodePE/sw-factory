// T66c: «añadir a suite». Genera una tarea candidata de benchmark desde un change terminado, en un fichero NUEVO que el dueño revisa.
// No toca nunca una suite existente: su digest la identifica (B2). Un change de canal se rechaza (B1): `runArm` crea un change local,
// que no es «de canal», así que su texto no confiable correría sin confinar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifierArgv } from './agent/mission-evidence.ts';
import { AdmissionDb, hasAdmission } from './admission/db.ts';
import { isChannelChange } from './admission/channel.ts';
import { parseSuite, type Split, type SuiteTask } from './improve.ts';
import { Store, StoreError } from './store.ts';

export interface TaskSpec { id: string; split: Split; verify?: string }

const quote = (a: string) => /^[A-Za-z0-9_./=:@%+,-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`;

export function suiteTaskFromChange(store: Store, changeId: string, i: TaskSpec): SuiteTask {
  const change = store.getChange(changeId);
  if (change.status !== 'completed') throw new StoreError('invalid_transition', `el change ${changeId} está ${change.status}: solo se añade uno completed`);
  if (!change.baseSha) throw new StoreError('invalid_input', `el change ${changeId} no tiene baseSha`);
  if (hasAdmission(store) && isChannelChange(new AdmissionDb(store), changeId))
    throw new StoreError('invalid_input', 'un change que entró por un canal no se añade a una suite: copia la descripción a mano tras revisarla');
  const ws = store.getWorkstream(change.workstreamId);
  let verify = i.verify;
  if (verify === undefined) {
    const argv = ws.verify.length === 1 ? ws.verify[0]! : undefined;
    const rebuilt = argv?.map(quote).join(' ');
    // Solo se acepta la reconstrucción si vuelve exactamente al mismo argv.
    const same = (() => { try { return JSON.stringify(verifierArgv(rebuilt!)) === JSON.stringify(argv); } catch { return false; } })();
    if (!rebuilt || !same) throw new StoreError('invalid_input', 'no se puede deducir el comando de verificación (hay varios, ninguno o no es reconstruible): pásalo con --verify');
    verify = rebuilt;
  }
  const task: SuiteTask = { id: i.id, repo: ws.repo, base: change.baseSha, description: change.description, verify, split: i.split };
  return parseSuite({ tasks: [task] }).tasks[0]!;
}

/** Escribe `out` (que no debe existir) con la tarea, más las de `suitePath` si se da. La salida pasa `parseSuite`. */
export function writeSuiteWithTask(store: Store, changeId: string, i: TaskSpec & { out: string; suitePath?: string }): void {
  if (existsSync(i.out)) throw new StoreError('conflict', `${i.out} ya existe: add-task solo escribe ficheros nuevos`);
  const task = suiteTaskFromChange(store, changeId, i);
  const previous = i.suitePath ? parseSuite(JSON.parse(readFileSync(i.suitePath, 'utf8'))).tasks : [];
  const suite = parseSuite({ tasks: [...previous, task] });
  mkdirSync(dirname(i.out), { recursive: true });
  writeFileSync(i.out, JSON.stringify(suite, null, 2) + '\n', { flag: 'wx' });
}
