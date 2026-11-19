// Terminal para la autorización del canal: los estados que admiten retry aún pueden revocarse.
import type { ChangeStatus } from '../store.ts';

export const isTerminalForMandate = (status: ChangeStatus): boolean => ['completed', 'canceled', 'declined'].includes(status);
