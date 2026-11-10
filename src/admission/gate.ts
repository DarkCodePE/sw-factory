// Gate determinista de admisión: función pura y sin modelo. Su entrada son solo metadatos verificados
// (ADR-0007, R13): el título y el cuerpo del issue no forman parte del tipo, así que no pueden influir.
export type GatePolicy = {
  repos: string[];
  /** Etiqueta de disparo: sin ella no se admite nada. Solo cuenta si la puso alguien con rol de triage o superior. */
  triggerLabel: string;
  /** Valores de `author_association` de la API de GitHub que se consideran de confianza. */
  trustedAssociations: string[];
  allowAuthors: string[];
};
/** Quién puso la etiqueta de disparo y su rol en el repo (`role_name` de la API, o 'bot' / 'unknown' si no se pudo comprobar). */
export type Labeler = { login: string; role: string };
export type GateInput = {
  repo: string; labels: string[]; author: string; authorAssociation: string; state: 'open' | 'closed'; labeler?: Labeler;
};
export type GateDecision = {
  would_admit: boolean;
  strength: 'explicit' | 'inferred';
  scope_max: 'none' | 'propose' | 'change';
  reasons: string[];
};

export const DEFAULT_POLICY = { triggerLabel: 'fab', trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'], allowAuthors: [] as string[] };

// Roles de GitHub que pueden etiquetar issues. Una issue form, un bot o un usuario con rol `read` también pueden dejar
// la etiqueta puesta, pero no cuentan como señal explícita (D2).
const LABEL_ROLES = ['admin', 'maintain', 'write', 'triage'];
const lower = (values: string[]) => values.map(value => value.toLowerCase());

export function gate(input: GateInput, policy: GatePolicy): GateDecision {
  const deny = (reason: string): GateDecision => ({ would_admit: false, strength: 'inferred', scope_max: 'none', reasons: [reason] });
  if (!lower(policy.repos).includes(input.repo.toLowerCase())) return deny('repo-not-allowed');
  if (input.state !== 'open') return deny('issue-not-open');
  if (!lower(input.labels).includes(policy.triggerLabel.toLowerCase())) return deny('no-trigger-label');
  const by = input.labeler ? `label-by:${input.labeler.login}(${input.labeler.role})` : 'label-by:?';
  if (!input.labeler || !LABEL_ROLES.includes(input.labeler.role)) return { ...deny('label-not-verified'), reasons: ['label-not-verified', by] };
  const trusted = lower(policy.allowAuthors).includes(input.author.toLowerCase()) ||
    policy.trustedAssociations.includes(input.authorAssociation);
  return trusted
    ? { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', by, 'author-trusted'] }
    : { would_admit: true, strength: 'explicit', scope_max: 'propose', reasons: ['trigger-label', by, 'author-untrusted'] };
}
