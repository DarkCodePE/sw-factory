// Aplicar la decisión de admisión (T30, H-15): `scope_max` deja de ser solo una anotación. Con comandos del Store que ya
// existen (addSignal / triageSignal); la admisión no escribe en tablas de la fab. El contenido es la copia admitida (T20),
// nunca una relectura. Lo invoca el efecto de admisión del modo auto (T12); el modo observe no llama a esto.
import type { Store } from '../store.ts';
import type { AdmissionDb } from './db.ts';
import type { CrashPoint } from './effects.ts';
import type { GateDecision } from './gate.ts';
import { ThreadLinks } from './links.ts';

export type Applied = { scope: 'none' } | { scope: 'propose'; signalId: string } | { scope: 'change'; signalId: string; changeId: string };

/**
 * `none` no hace nada; `propose` solo crea el signal (queda para triage humano); `change` lo triaja y crea el change, y une el hilo.
 * Todo en una transacción y una vez por hilo: repetir (o reejecutar tras una caída) devuelve lo ya creado sin duplicar el signal.
 */
export function applyAdmission(store: Store, adm: AdmissionDb, p: { thread: string; workstream: string; decision: Pick<GateDecision, 'would_admit' | 'scope_max'>; crash?: (point: CrashPoint) => void }): Applied {
  if (!p.decision.would_admit || p.decision.scope_max === 'none') return { scope: 'none' };
  return adm.tx(() => {
    const prior = adm.db.query('SELECT signal_id, scope FROM adm_thread_signals WHERE thread_id = ?').get(p.thread) as { signal_id: string; scope: 'propose' | 'change' } | null;
    const links = new ThreadLinks(adm);
    if (prior) {
      const changeId = links.changeOf(p.thread);
      return prior.scope === 'change' && changeId ? { scope: 'change', signalId: prior.signal_id, changeId } : { scope: 'propose', signalId: prior.signal_id };
    }
    const content = adm.db.query('SELECT title, body FROM adm_content WHERE thread_id = ?').get(p.thread) as { title: string; body: string } | null;
    if (!content) throw new Error(`hilo ${p.thread}: no hay contenido admitido (T20); no se crea el signal`);
    const signal = store.addSignal(p.workstream, content.title, content.body);
    const scope = p.decision.scope_max;
    const change = scope === 'change' ? store.triageSignal(signal.id) : undefined;
    adm.db.query('INSERT INTO adm_thread_signals(thread_id, signal_id, scope, created_at) VALUES (?,?,?,?)').run(p.thread, signal.id, scope, adm.iso());
    if (change) links.link(p.thread, change.id);
    p.crash?.('signal-created');
    return change ? { scope: 'change', signalId: signal.id, changeId: change.id } : { scope: 'propose', signalId: signal.id };
  });
}
