// Gate determinista de admisión: función pura y sin modelo. Su entrada son solo metadatos verificados
// (ADR-0007, R13): el título y el cuerpo del issue no forman parte del tipo, así que no pueden influir.
export type GatePolicy = {
  repos: string[];
  /** Etiqueta que solo puede poner quien tiene permisos de triage sobre el repo: señal explícita. */
  triggerLabel: string;
  /** Valores de `author_association` de la API de GitHub que se consideran de confianza. */
  trustedAssociations: string[];
  allowAuthors: string[];
};
export type GateInput = { repo: string; labels: string[]; author: string; authorAssociation: string; state: 'open' | 'closed' };
export type GateDecision = {
  would_admit: boolean;
  strength: 'explicit' | 'inferred';
  scope_max: 'none' | 'propose' | 'change';
  reasons: string[];
};

export const DEFAULT_POLICY = { triggerLabel: 'fab', trustedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'], allowAuthors: [] as string[] };

const lower = (values: string[]) => values.map(value => value.toLowerCase());

export function gate(input: GateInput, policy: GatePolicy): GateDecision {
  const deny = (reason: string): GateDecision => ({ would_admit: false, strength: 'inferred', scope_max: 'none', reasons: [reason] });
  if (!lower(policy.repos).includes(input.repo.toLowerCase())) return deny('repo-not-allowed');
  if (input.state !== 'open') return deny('issue-not-open');
  const trusted = lower(policy.allowAuthors).includes(input.author.toLowerCase()) ||
    policy.trustedAssociations.includes(input.authorAssociation);
  const labeled = lower(input.labels).includes(policy.triggerLabel.toLowerCase());
  if (labeled && trusted) return { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', 'author-trusted'] };
  if (labeled) return { would_admit: true, strength: 'explicit', scope_max: 'propose', reasons: ['trigger-label', 'author-untrusted'] };
  if (trusted) return { would_admit: true, strength: 'inferred', scope_max: 'propose', reasons: ['author-trusted', 'no-trigger-label'] };
  return deny('author-untrusted-no-label');
}
