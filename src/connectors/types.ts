// Shared contract for the SDLC connectors: ticket intake (Jira), pull requests (GitHub)
// and validator activities on a change. Interfaces only; implementations live next to this file
// (connectors) and in src/validators/. Changing this file is the integrator's call.

/** A ticket outside fab that a change came from. */
export interface ExternalRef {
  system: 'jira';
  /** Issue key, e.g. KAN-12. */
  key: string;
  /** Browse URL of the issue. */
  url: string;
}

/** A ticket as fab needs it to open a change. Text fields are plain text (ADF already flattened). */
export interface TicketIssue {
  ref: ExternalRef;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  /** Acceptance criteria when the ticket keeps them apart from the description. */
  acceptance?: string;
  /** Subtask summaries, in Jira order. */
  subtasks: string[];
}

export interface TicketGateway {
  getIssue(key: string): Promise<TicketIssue>;
  /** Add a comment written in Markdown; the gateway converts it to the tracker's format. */
  comment(key: string, markdown: string): Promise<void>;
}

/** A pull request opened for a change branch. */
export interface PullRequestRef {
  /** owner/name on GitHub. */
  repo: string;
  number: number;
  url: string;
  branch: string;
  base: string;
}

export interface OpenPullRequestInput {
  /** Local checkout the branch lives in; the gateway pushes from here. */
  cwd: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequestGateway {
  /** Push the branch and open the PR; returns the existing PR when one is already open for the branch. */
  open(input: OpenPullRequestInput): Promise<PullRequestRef>;
  find(repo: string, branch: string): Promise<PullRequestRef | undefined>;
  comment(pr: PullRequestRef, markdown: string): Promise<void>;
}

/** What links a change to the outside world. Kept by the connectors, read by the validators. */
export interface ChangeLinks {
  changeId: string;
  source?: ExternalRef;
  pr?: PullRequestRef;
}

export type ChangeLinkLookup = (changeId: string) => ChangeLinks | undefined;

/** Validator activities: change_review activities run by a worker, one per validator. */
export const VALIDATOR_KINDS = ['code_review', 'security_audit', 'qa'] as const;
export type ValidatorKind = (typeof VALIDATOR_KINDS)[number];

export type ValidationVerdict = 'pass' | 'fail' | 'needs_human';

export interface ValidationResult {
  validator: ValidatorKind;
  activityId: string;
  /** undefined while the activity is pending, running, or failed without a verdict. */
  verdict?: ValidationVerdict;
  /** True when the activity failed for good, so a missing verdict is final rather than pending. */
  failed?: boolean;
  /** One-paragraph summary taken from the validator's report. */
  summary: string;
}

export interface ValidationSummary {
  changeId: string;
  results: ValidationResult[];
  /** True only when every requested validator finished with `pass`. */
  passed: boolean;
  /** True while any requested validator is pending or running. */
  pending: boolean;
}
