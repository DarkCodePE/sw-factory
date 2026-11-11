// Vínculo hilo → change (T23, H-08). Relación N hilos → 1 change: el issue que se admitió y el PR que abre la fab son hilos
// distintos del mismo trabajo. Un hilo solo se admite una vez. La admisión no escribe en tablas de la fab: el origen externo
// del change va por ChangeLinkStore (mismo patrón que Jira, ADR-0001); el resto vive en `adm_thread_changes`.
import { ChangeLinkStore } from '../connectors/links.ts';
import type { AdmissionDb } from './db.ts';

/** `github:owner/repo#12` → `{ repo: 'owner/repo', number: 12 }`. Lanza si el hilo no es de GitHub. */
export function parseThread(threadId: string): { repo: string; number: number } {
  const m = /^github:([^#]+)#(\d+)$/.exec(threadId);
  if (!m) throw new Error(`hilo inválido: ${threadId}`);
  return { repo: m[1]!, number: Number(m[2]) };
}

export class ThreadLinks {
  private readonly changeLinks: ChangeLinkStore;
  constructor(private readonly adm: AdmissionDb) { this.changeLinks = new ChangeLinkStore(adm.db); }

  changeOf(threadId: string): string | undefined {
    return (this.adm.db.query('SELECT change_id FROM adm_thread_changes WHERE thread_id = ?').get(threadId) as { change_id: string } | null)?.change_id;
  }
  threadsOf(changeId: string): string[] {
    return (this.adm.db.query('SELECT thread_id FROM adm_thread_changes WHERE change_id = ? ORDER BY linked_at, rowid').all(changeId) as { thread_id: string }[]).map(r => r.thread_id);
  }

  /**
   * Une un hilo a un change. Idempotente para el mismo par; un hilo ya unido a otro change lanza. El primer hilo del change
   * fija su `ExternalRef` (`github`); los siguientes solo quedan en `adm_thread_changes`.
   */
  link(threadId: string, changeId: string): void {
    const { repo, number } = parseThread(threadId);
    this.adm.tx(() => {
      const current = this.changeOf(threadId);
      if (current === changeId) return;
      if (current) throw new Error(`El hilo ${threadId} ya está unido al change ${current}`);
      this.adm.db.query('INSERT INTO adm_thread_changes(thread_id, change_id, linked_at) VALUES (?,?,?)').run(threadId, changeId, this.adm.iso());
      if (!this.changeLinks.get(changeId)?.source) this.changeLinks.setSource(changeId, { system: 'github', key: `${repo}#${number}`, url: `https://github.com/${repo}/issues/${number}` });
    });
  }
}
