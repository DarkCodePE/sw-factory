import type { Activity, Change } from '../store.ts';
import { Store } from '../store.ts';
import { ChangeLinkStore } from './links.ts';
import { validateJiraKey } from './jira.ts';
import type { ChangeLinks, TicketGateway, TicketIssue } from './types.ts';

export function issueToSignal(issue: TicketIssue): { title: string; body: string } {
  return { title: `${issue.ref.key} ${issue.summary}`, body: [
    '## Descripción', issue.description || '(Sin descripción)',
    ...(issue.acceptance ? ['## Criterios de aceptación', issue.acceptance] : []),
    ...(issue.subtasks.length ? ['## Subtareas', issue.subtasks.map(s => `- ${s}`).join('\n')] : []),
    `HU: ${issue.ref.url}`,
  ].join('\n\n') };
}

export async function importIssue(store: Store, links: ChangeLinkStore, tickets: TicketGateway,
  opts: { workstream: string; key: string; triage: boolean }): Promise<{ signalId: string; changeId?: string; reused: boolean }> {
  validateJiraKey(opts.key);
  const ws = store.getWorkstream(opts.workstream);
  function existing() {
    const linked = links.findBySource('jira', opts.key);
    const signalId = links.importedSignal(opts.key);
    if (linked) {
      const change = store.getChange(linked.changeId);
      const signal = store.listSignals(change.workstreamId).find(s => s.changeId === change.id);
      if (!signal) throw new Error(`HU ${opts.key} enlazada a un change sin signal de origen`);
      return { signalId: signal.id, changeId: change.id, reused: true };
    }
    if (signalId) {
      const signal = store.listWorkstreams().flatMap(w => store.listSignals(w.id)).find(s => s.id === signalId);
      if (!signal) throw new Error('El registro de importación Jira no tiene signal');
      if (signal.workstreamId !== ws.id) throw new Error(`HU ${opts.key} ya importada en otro workstream`);
      return { signalId, ...(signal.changeId ? { changeId: signal.changeId } : {}), reused: true };
    }
  }
  const prior = existing();
  if (prior && (links.findBySource('jira', opts.key) || !prior.changeId && !opts.triage)) return prior;
  const issue = await tickets.getIssue(opts.key);
  if (issue.ref.system !== 'jira' || issue.ref.key !== opts.key) throw new Error('La HU recibida no coincide con la solicitada');
  return store.db.transaction(() => {
    const prior = existing();
    if (prior?.changeId) { links.setSource(prior.changeId, issue.ref); return prior; }
    let signalId = prior?.signalId;
    if (!signalId) {
      const signal = issueToSignal(issue);
      signalId = store.addSignal(ws.id, signal.title, signal.body).id;
      links.recordImport(opts.key, signalId, issue.ref.url);
    }
    const change = opts.triage ? store.triageSignal(signalId) : undefined;
    if (change) links.setSource(change.id, issue.ref);
    return { signalId, ...(change ? { changeId: change.id } : {}), reused: !!prior };
  })();
}

export function pullRequestBody(change: Change, links: ChangeLinks | undefined, activities: Activity[]): string {
  const investigation = activities.filter(a => a.kind === 'investigation' && a.status === 'completed' && a.result).at(-1)?.result;
  return [`# ${change.title}`, ...(links?.source ? [`HU de origen: [${links.source.key}](${links.source.url})`] : []),
    '## Investigación', investigation ? investigation.slice(0, 4000) + (investigation.length > 4000 ? '\n… (recortado)' : '') : '(Sin informe de investigación)',
    `Cerrado por fab change ${change.id.slice(0, 8)}`].join('\n\n');
}

export function ticketComment(kind: 'pr_opened' | 'merged' | 'status', change: Change, links: ChangeLinks, extra?: string): string {
  const heading = { pr_opened: 'PR abierto', merged: 'Cambio fusionado', status: 'Estado del cambio' }[kind];
  return [`## ${heading}`, `${change.title}\n\nChange: ${change.id.slice(0, 8)}\nEstado: ${change.status}`,
    ...(links.pr ? [`PR: [${links.pr.repo}#${links.pr.number}](${links.pr.url})`] : []), ...(extra ? [extra] : [])].join('\n\n');
}
