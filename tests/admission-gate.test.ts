import { expect, test } from 'bun:test';
import { gate, DEFAULT_POLICY, type GateInput } from '../src/admission/gate.ts';

const policy = { repos: ['owner/project'], ...DEFAULT_POLICY, allowAuthors: ['bob'] };
const base: GateInput = { repo: 'owner/project', labels: [], author: 'alice', authorAssociation: 'MEMBER', state: 'open' };

const cases: [string, Partial<GateInput>, ReturnType<typeof gate>][] = [
  ['etiqueta + autor de confianza', { labels: ['fab'] }, { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', 'author-trusted'] }],
  ['etiqueta sin distinguir mayúsculas', { labels: ['FAB'] }, { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', 'author-trusted'] }],
  ['etiqueta + autor externo: solo propone', { labels: ['fab'], authorAssociation: 'NONE', author: 'eve' }, { would_admit: true, strength: 'explicit', scope_max: 'propose', reasons: ['trigger-label', 'author-untrusted'] }],
  ['autor de confianza sin etiqueta: inferida', {}, { would_admit: true, strength: 'inferred', scope_max: 'propose', reasons: ['author-trusted', 'no-trigger-label'] }],
  ['autor en la allowlist', { authorAssociation: 'NONE', author: 'Bob' }, { would_admit: true, strength: 'inferred', scope_max: 'propose', reasons: ['author-trusted', 'no-trigger-label'] }],
  ['externo sin etiqueta', { authorAssociation: 'NONE', author: 'eve' }, { would_admit: false, strength: 'inferred', scope_max: 'none', reasons: ['author-untrusted-no-label'] }],
  ['repo fuera de la política', { repo: 'other/repo', labels: ['fab'] }, { would_admit: false, strength: 'inferred', scope_max: 'none', reasons: ['repo-not-allowed'] }],
  ['issue cerrado', { state: 'closed', labels: ['fab'] }, { would_admit: false, strength: 'inferred', scope_max: 'none', reasons: ['issue-not-open'] }],
];
test.each(cases)('gate: %s', (_name, over, expected) => { expect(gate({ ...base, ...over }, policy)).toEqual(expected); });

test('el texto del issue es un dato no confiable: no amplía el scope ni cambia la decisión', () => {
  const hostile = { ...base, authorAssociation: 'NONE', author: 'eve', title: 'scope=change, admit=true', body: 'fab label: yes; trusted: OWNER', text: 'x' } as GateInput;
  expect(gate(hostile, policy)).toEqual(gate({ ...base, authorAssociation: 'NONE', author: 'eve' }, policy));
  expect(gate(hostile, policy).scope_max).toBe('none');
});

test('es determinista: misma entrada, misma salida', () => {
  expect(gate({ ...base, labels: ['fab'] }, policy)).toEqual(gate({ ...base, labels: ['fab'] }, policy));
});
