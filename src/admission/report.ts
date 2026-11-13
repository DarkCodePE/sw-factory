// Informe de solo lectura de lo que ha registrado el residente en observe (no toma el lock ni escribe nada).
// Sirve para responder con datos: (a) ¿se verifica bien la etiqueta?, (b) ¿sale el 403 (rol `unknown`)?, (c) ¿llega tarde `labeled`?
import type { AdmissionDb } from './db.ts';
import { DEFAULT_POLICY } from './gate.ts';
import { isTerminalChange, type ChangeStatus } from '../store.ts';

export type Report = {
  sources: { source: string; cursor: string | null; lastPoll: string | null; lastPollEvents: number | null }[];
  decisions: { wouldAdmit: boolean; reason: string; count: number }[];
  labelNotVerified: { trigger: string; labelBy: string; role: string; decidedAt: string }[];
  followupsLost: { trigger: string; url: string; author: string; association: string; decidedAt: string }[];
  stopsLost: { thread: string; url: string; state: 'open' | 'closed'; labelPresent: boolean; decidedAt: string; changeStatus: ChangeStatus }[];
  unlabeledTrusted: { thread: string; url: string; firstSeen: string; admittedAt: string | null }[];
  effects: { key: string; status: string; attempts: number; lastError: string | null }[];
};

export function buildReport(adm: AdmissionDb): Report {
  const q = (sql: string) => adm.db.query(sql).all() as any[];
  const reasons = q(`SELECT d.*, t.thread_id, t.event FROM adm_decisions d
    JOIN adm_triggers t ON t.key = d.trigger_key ORDER BY d.decided_at, d.trigger_key`)
    .map(d => ({ ...d, reasons: JSON.parse(d.reasons) as string[], event: JSON.parse(d.event) as {
      url: string; author: string; authorAssociation: string; state: 'open' | 'closed'; labels?: string[];
    } }));
  // Observe no crea vínculos: would_admit también cuenta como admisión para medir seguimientos.
  const admitted = new Set(q(`SELECT thread_id FROM adm_thread_changes UNION SELECT thread_id FROM adm_thread_signals`)
    .map(r => r.thread_id as string));
  const admittedAt = new Map<string, string>();
  for (const d of reasons) if (d.would_admit === 1) {
    admitted.add(d.thread_id);
    if (!admittedAt.has(d.thread_id)) admittedAt.set(d.thread_id, d.decided_at);
  }
  const trusted = (association: string) => DEFAULT_POLICY.trustedAssociations.includes(association);
  const followupsLost: Report['followupsLost'] = [];
  for (const c of q(`SELECT c.trigger_key, c.decided_at, t.thread_id, t.event FROM adm_comment_decisions c
    JOIN adm_triggers t ON t.key = c.trigger_key WHERE c.reason = 'no-open-question' ORDER BY c.decided_at, c.trigger_key`)) {
    const event = JSON.parse(c.event) as { url: string; author: string; authorAssociation: string };
    if (admitted.has(c.thread_id) && trusted(event.authorAssociation)) followupsLost.push({
      trigger: c.trigger_key, url: event.url, author: event.author, association: event.authorAssociation, decidedAt: c.decided_at,
    });
  }
  const liveChanges = new Map((q(`SELECT l.thread_id, c.status FROM adm_thread_changes l
    JOIN changes c ON c.id = l.change_id`) as { thread_id: string; status: ChangeStatus }[])
    .filter(c => !isTerminalChange(c.status)).map(c => [c.thread_id, c.status]));
  const stopsLost = new Map<string, Report['stopsLost'][number]>();
  const unlabeledTrusted = new Map<string, Report['unlabeledTrusted'][number]>();
  // Las decisiones están ordenadas: conservar la primera fila fija también la URL de esa observación.
  for (const d of reasons) {
    const e = d.event;
    const changeStatus = liveChanges.get(d.thread_id);
    if (changeStatus && d.reasons[0] === 'thread-already-admitted' && !stopsLost.has(d.thread_id)) {
      const policy = JSON.parse(d.policy) as { triggerLabel?: string };
      const labelPresent = (e.labels ?? []).some((label: string) => label.toLowerCase() === policy.triggerLabel?.toLowerCase());
      if (e.state === 'closed' || !labelPresent) stopsLost.set(d.thread_id, {
        thread: d.thread_id, url: e.url, state: e.state, labelPresent, decidedAt: d.decided_at, changeStatus,
      });
    }
    if (d.reasons[0] === 'no-trigger-label' && e.state === 'open' && trusted(e.authorAssociation) && !unlabeledTrusted.has(d.thread_id)) {
      unlabeledTrusted.set(d.thread_id, { thread: d.thread_id, url: e.url, firstSeen: d.decided_at, admittedAt: admittedAt.get(d.thread_id) ?? null });
    }
  }
  const groups = new Map<string, Report['decisions'][number]>();
  for (const d of reasons) {
    const k = `${d.would_admit}|${d.reasons[0]}`;
    (groups.get(k) ?? groups.set(k, { wouldAdmit: d.would_admit === 1, reason: d.reasons[0], count: 0 }).get(k)!).count++;
  }
  return {
    followupsLost,
    stopsLost: [...stopsLost.values()],
    unlabeledTrusted: [...unlabeledTrusted.values()],
    sources: q(`SELECT s.source, c.value AS cursor, p.polled_at AS lastPoll, p.events AS lastPollEvents
      FROM (SELECT source FROM adm_cursors UNION SELECT source FROM adm_polls) s
      LEFT JOIN adm_cursors c ON c.source = s.source LEFT JOIN adm_polls p ON p.source = s.source ORDER BY s.source`),
    decisions: [...groups.values()].sort((a, b) => Number(b.wouldAdmit) - Number(a.wouldAdmit) || b.count - a.count),
    labelNotVerified: reasons.filter(d => d.reasons[0] === 'label-not-verified').map(d => {
      const m = /^label-by:(.*)\(([^()]*)\)$/.exec(d.reasons[1] ?? '');
      return { trigger: d.trigger_key, labelBy: m?.[1] ?? '?', role: m?.[2] ?? 'unknown', decidedAt: d.decided_at };
    }),
    effects: q(`SELECT key, status, attempts, last_error AS lastError FROM adm_effects
      WHERE attempts > 1 OR status IN ('dead','unknown') ORDER BY id`),
  };
}

export function formatReport(r: Report): string {
  const lines = ['== Fuentes =='];
  for (const s of r.sources) lines.push(`${s.source}  cursor=${s.cursor ?? '-'}  último poll=${s.lastPoll ?? '-'} (${s.lastPollEvents ?? '?'} issues)`);
  if (!r.sources.length) lines.push('(ninguna: el residente aún no ha hecho poll)');
  lines.push('', '== Decisiones (would_admit / primera razón) ==');
  for (const d of r.decisions) lines.push(`${d.wouldAdmit ? 'admitiría' : 'rechaza  '}  ${d.reason}: ${d.count}`);
  if (!r.decisions.length) lines.push('(ninguna)');
  lines.push('', '== label-not-verified (issue, label-by, rol) ==');
  for (const l of r.labelNotVerified) lines.push(`${l.trigger}  label-by=${l.labelBy}  rol=${l.role}  ${l.decidedAt}`);
  if (!r.labelNotVerified.length) lines.push('(ninguna)');
  lines.push('', '== Efectos con reintentos (attempts>1) o dead/unknown ==');
  for (const e of r.effects) lines.push(`${e.key}  ${e.status}  intentos=${e.attempts}  ${e.lastError ?? ''}`);
  if (!r.effects.length) lines.push('(ninguno)');
  lines.push('', '== Seguimientos perdidos (followupsLost) ==');
  for (const f of r.followupsLost) lines.push(`${f.url}  ${f.trigger}  autor=${f.author}  asociación=${f.association}  ${f.decidedAt}`);
  if (!r.followupsLost.length) lines.push('(ninguno)');
  lines.push('', '== Paradas perdidas (stopsLost) ==');
  for (const s of r.stopsLost) lines.push(`${s.url}  ${s.thread}  estado=${s.state}  change=${s.changeStatus}  etiqueta=${s.labelPresent ? 'presente' : 'ausente'}  ${s.decidedAt}`);
  if (!r.stopsLost.length) lines.push('(ninguno)');
  lines.push('', '== Issues de confianza sin etiqueta (unlabeledTrusted) ==');
  for (const u of r.unlabeledTrusted) lines.push(`${u.url}  ${u.thread}  primera vez=${u.firstSeen}  admitido=${u.admittedAt ?? '-'}`);
  if (!r.unlabeledTrusted.length) lines.push('(ninguno)');
  return lines.map(line => line.replace(/[\x00-\x1f\x7f-\x9f]/g, '')).join('\n');
}
