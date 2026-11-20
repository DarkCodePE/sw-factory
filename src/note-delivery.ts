import { CONFINABLE_AGENTS } from './sandbox/confine.ts';
import type { Activity, ReservedChangeNote, Store } from './store.ts';

/** Tope del prompt completo cuando incluye adjuntos, medido como en la entrada UTF-8. */
const ATTACHED_PROMPT_MAX = 128 * 1024;

export function reserveTurnPrompt(store: Store, activity: Activity, attemptId: string, route: {
  cwd: string; remote?: boolean; confine?: boolean; adapter: string; promptStdin?: boolean; persistentMounts?: string[];
}, build: (notes: ReservedChangeNote[]) => string): { prompt: string; reserved: number; hasAttachments: boolean } {
  let fittedPrompt: string | undefined;
  const fits = (notes: ReservedChangeNote[]) => {
    const prompt = build(notes);
    if (Buffer.byteLength(prompt) > ATTACHED_PROMPT_MAX) return false;
    fittedPrompt = prompt;
    return true;
  };
  const eligible = route.confine && route.promptStdin && CONFINABLE_AGENTS.includes(route.adapter);
  const notes = store.reserveNotes(activity.changeId, activity.id, attemptId, route.remote ? { blockedBy: 'remote' }
    : eligible ? { cwd: route.cwd, persistentMounts: route.persistentMounts, fits } : { blockedBy: 'transport' });
  return { prompt: fittedPrompt ?? build(notes), reserved: notes.length, hasAttachments: notes.some(n => n.attachmentBytes !== undefined) };
}
