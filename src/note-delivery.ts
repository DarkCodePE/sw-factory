import { CONFINABLE_AGENTS } from './sandbox/confine.ts';
import type { NoteAttachmentTarget } from './note-attachments.ts';
import type { Activity, ReservedChangeNote, Store } from './store.ts';

/** Tope del prompt completo cuando incluye adjuntos, medido como en la entrada UTF-8. */
const ATTACHED_PROMPT_MAX = 128 * 1024;

export function reserveTurnPrompt(store: Store, activity: Activity, attemptId: string, route: {
  cwd: string; remote?: boolean; confine?: boolean; adapter: string; promptStdin?: boolean; persistentMounts?: string[];
  /** Inventario ya calculado por quien abre una transacción propia (el turno vivo). */
  prepared?: NoteAttachmentTarget;
}, build: (notes: ReservedChangeNote[]) => string): { prompt: string; reserved: number; hasAttachments: boolean } {
  let fittedPrompt: string | undefined;
  const fits = (notes: ReservedChangeNote[]) => {
    const prompt = build(notes);
    if (Buffer.byteLength(prompt) > ATTACHED_PROMPT_MAX) return false;
    fittedPrompt = prompt;
    return true;
  };
  const eligible = route.confine && route.promptStdin && CONFINABLE_AGENTS.includes(route.adapter);
  const target = eligible ? route.prepared ?? prepareNoteTarget(store, activity.changeId, route) : undefined;
  const notes = store.reserveNotes(activity.changeId, activity.id, attemptId, route.remote ? { blockedBy: 'remote' }
    : target ? { ...target, fits } : { blockedBy: 'transport' });
  return { prompt: fittedPrompt ?? build(notes), reserved: notes.length, hasAttachments: notes.some(n => n.attachmentBytes !== undefined) };
}

/** Git corre fuera de la transacción de la reserva. Sin adjuntos pendientes no hace falta inventario. */
export function prepareNoteTarget(store: Store, changeId: string, route: { cwd: string; persistentMounts?: string[] }): NoteAttachmentTarget {
  const target = { cwd: route.cwd, persistentMounts: route.persistentMounts };
  return store.hasPendingNoteAttachments(changeId) ? store.prepareNoteDelivery(target) : target;
}
