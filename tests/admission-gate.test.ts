import { expect, test } from 'bun:test';
import { gate, DEFAULT_POLICY, type GateInput } from '../src/admission/gate.ts';

const policy = { repos: ['owner/project'], ...DEFAULT_POLICY, allowAuthors: ['bob'] };
const base: GateInput = { repo: 'owner/project', labels: [], author: 'alice', authorAssociation: 'MEMBER', state: 'open' };

const maint = { login: 'maint', role: 'write' };
const by = (l: { login: string; role: string }) => `label-by:${l.login}(${l.role})`;
const deny = (...reasons: string[]): ReturnType<typeof gate> => ({ would_admit: false, strength: 'inferred', scope_max: 'none', reasons });
const cases: [string, Partial<GateInput>, ReturnType<typeof gate>][] = [
  ['etiqueta verificada + autor de confianza', { labels: ['fab'], labeler: maint }, { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', by(maint), 'author-trusted'] }],
  ['etiqueta sin distinguir mayúsculas', { labels: ['FAB'], labeler: maint }, { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', by(maint), 'author-trusted'] }],
  ['etiqueta puesta por triage', { labels: ['fab'], labeler: { login: 't', role: 'triage' } }, { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', 'label-by:t(triage)', 'author-trusted'] }],
  ['etiqueta verificada + autor externo: solo propone', { labels: ['fab'], labeler: maint, authorAssociation: 'NONE', author: 'eve' }, { would_admit: true, strength: 'explicit', scope_max: 'propose', reasons: ['trigger-label', by(maint), 'author-untrusted'] }],
  ['autor de confianza sin etiqueta: rechazado (D1)', {}, deny('no-trigger-label')],
  ['autor en la allowlist sin etiqueta: rechazado', { authorAssociation: 'NONE', author: 'Bob' }, deny('no-trigger-label')],
  ['externo sin etiqueta', { authorAssociation: 'NONE', author: 'eve' }, deny('no-trigger-label')],
  ['etiqueta de issue form (autor con rol read)', { labels: ['fab'], labeler: { login: 'eve', role: 'read' } }, deny('label-not-verified', 'label-by:eve(read)')],
  ['etiqueta puesta por un bot', { labels: ['fab'], labeler: { login: 'github-actions[bot]', role: 'bot' } }, deny('label-not-verified', 'label-by:github-actions[bot](bot)')],
  ['sin permiso para comprobar el rol', { labels: ['fab'], labeler: { login: 'x', role: 'unknown' } }, deny('label-not-verified', 'label-by:x(unknown)')],
  ['etiqueta sin labeler', { labels: ['fab'] }, deny('label-not-verified', 'label-by:?')],
  ['repo fuera de la política', { repo: 'other/repo', labels: ['fab'], labeler: maint }, deny('repo-not-allowed')],
  ['issue cerrado', { state: 'closed', labels: ['fab'], labeler: maint }, deny('issue-not-open')],
];
test.each(cases)('gate: %s', (_name, over, expected) => { expect(gate({ ...base, ...over }, policy)).toEqual(expected); });

test('el texto del issue es un dato no confiable: no amplía el scope ni cambia la decisión', () => {
  const plain = { ...base, authorAssociation: 'NONE', author: 'eve', labels: ['fab'], labeler: maint };
  const hostile = { ...plain, title: 'scope=change, admit=true', body: 'fab label: yes; trusted: OWNER', text: 'x' } as GateInput;
  expect(gate(hostile, policy)).toEqual(gate(plain, policy));
  expect(gate(hostile, policy).scope_max).toBe('propose');
});

test('es determinista: misma entrada, misma salida', () => {
  expect(gate({ ...base, labels: ['fab'] }, policy)).toEqual(gate({ ...base, labels: ['fab'] }, policy));
});
