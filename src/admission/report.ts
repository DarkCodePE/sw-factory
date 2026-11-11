// Informe de solo lectura de lo que ha registrado el residente en observe (no toma el lock ni escribe nada).
// Sirve para responder con datos: (a) ¿se verifica bien la etiqueta?, (b) ¿sale el 403 (rol `unknown`)?, (c) ¿llega tarde `labeled`?
import type { AdmissionDb } from './db.ts';

export type Report = {
  sources: { source: string; cursor: string | null; lastPoll: string | null; lastPollEvents: number | null }[];
  decisions: { wouldAdmit: boolean; reason: string; count: number }[];
  labelNotVerified: { trigger: string; labelBy: string; role: string; decidedAt: string }[];
  effects: { key: string; status: string; attempts: number; lastError: string | null }[];
};

export function buildReport(adm: AdmissionDb): Report {
  const q = (sql: string) => adm.db.query(sql).all() as any[];
  const reasons = q('SELECT trigger_key, would_admit, reasons, decided_at FROM adm_decisions ORDER BY decided_at, trigger_key')
    .map(d => ({ ...d, reasons: JSON.parse(d.reasons) as string[] }));
  const groups = new Map<string, Report['decisions'][number]>();
  for (const d of reasons) {
    const k = `${d.would_admit}|${d.reasons[0]}`;
    (groups.get(k) ?? groups.set(k, { wouldAdmit: d.would_admit === 1, reason: d.reasons[0], count: 0 }).get(k)!).count++;
  }
  return {
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
  return lines.join('\n');
}
