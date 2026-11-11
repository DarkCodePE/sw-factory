import { AdmissionDb } from '../../src/admission/db.ts';
import { Effects, type EffectHandler, type CrashPoint } from '../../src/admission/effects.ts';
import { Store } from '../../src/store.ts';

/** Store en memoria con un change y su primera activity ya reclamada por `w1`. */
export function claimed(handlers: Record<string, EffectHandler> = {}, opts: { crash?: (p: CrashPoint) => void; clock?: () => Date } = {}) {
  const store = new Store(':memory:', opts.clock ? { clock: opts.clock } : undefined);
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: '/tmp/none', agent: 'fake', requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.slug, 'active');
  const signal = store.addSignal(ws.slug, 'título', 'descripción');
  const change = store.triageSignal(signal.id);
  const adm = new AdmissionDb(store);
  const effects = new Effects(adm, { reply: { run: () => {}, rerunnable: false }, ...handlers }, { baseMs: 1, crash: opts.crash });
  const claim = (worker = 'w1') => store.claimActivity(ws.slug, worker)!;
  return { store, ws, change, adm, effects, claim };
}
