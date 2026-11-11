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
export type Labeler = { login: string; role: string; /** Cuándo se puso la etiqueta (`created_at` del evento `labeled`). */ at?: string };
export type GateInput = {
  repo: string; labels: string[]; author: string; authorAssociation: string; state: 'open' | 'closed'; labeler?: Labeler;
  /** Última edición de título/cuerpo (null: nunca editado). Solo se consulta cuando el resto del gate admitiría (T20). */
  contentEditedAt?: string | null;
  /** El contenido actual difiere del que se admitió bajo esa misma etiqueta. */
  contentChanged?: boolean;
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
  // La etiqueta prueba quién autorizó, no qué: si el contenido cambió después de etiquetar, hay que volver a etiquetar (T20, H-05).
  if (input.contentEditedAt !== undefined && !input.labeler.at) return { ...deny('label-time-unknown'), reasons: ['label-time-unknown', by] }; // no se puede probar el orden: se cierra
  if (input.labeler.at && ((input.contentEditedAt ?? '') > input.labeler.at || input.contentChanged)) return { ...deny('edited-after-label'), reasons: ['edited-after-label', by] };
  const trusted = lower(policy.allowAuthors).includes(input.author.toLowerCase()) ||
    policy.trustedAssociations.includes(input.authorAssociation);
  return trusted
    ? { would_admit: true, strength: 'explicit', scope_max: 'change', reasons: ['trigger-label', by, 'author-trusted'] }
    : { would_admit: true, strength: 'explicit', scope_max: 'propose', reasons: ['trigger-label', by, 'author-untrusted'] };
}
