// Domain vocabulary for the local software factory.
// Values follow the workstream -> signal -> change -> activity pipeline.

export const WorkstreamState = {
  Draft: 'draft',
  Active: 'active',
  Paused: 'paused',
  Archived: 'archived',
} as const;
export type WorkstreamState = (typeof WorkstreamState)[keyof typeof WorkstreamState];

export const SignalStatus = {
  New: 'new',
  Triaged: 'triaged',
  Duplicate: 'duplicate',
  Ignored: 'ignored',
} as const;
export type SignalStatus = (typeof SignalStatus)[keyof typeof SignalStatus];

export const ChangeStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  InReview: 'in_review',
  Implemented: 'implemented',
  Completed: 'completed',
  Failed: 'failed',
  Canceled: 'canceled',
  Declined: 'declined',
} as const;
export type ChangeStatus = (typeof ChangeStatus)[keyof typeof ChangeStatus];

export const ActivityKind = {
  ChangeReview: 'change_review',
  Investigation: 'investigation',
  Implementation: 'implementation',
  Steward: 'steward',
} as const;
export type ActivityKind = (typeof ActivityKind)[keyof typeof ActivityKind];

export const ActivityStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
  Failed: 'failed',
  Canceled: 'canceled',
} as const;
export type ActivityStatus = (typeof ActivityStatus)[keyof typeof ActivityStatus];

export const ReviewStatus = {
  Awaiting: 'awaiting',
  Approved: 'approved',
  Declined: 'declined',
  Commented: 'commented',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

export type ReviewDecision = 'approve' | 'comment' | 'decline';

export const TERMINAL_ACTIVITY: readonly ActivityStatus[] = ['completed', 'failed', 'canceled'];

/** Allowed workstream lifecycle transitions. */
export const WORKSTREAM_TRANSITIONS: Record<WorkstreamState, readonly WorkstreamState[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: ['paused'],
};

/** Activity kinds that a human reviews before the chain continues. */
export const REVIEWABLE_KINDS: readonly ActivityKind[] = ['change_review', 'investigation'];

/** What comes after an approved review, and what a "comment" re-queues. */
export const REVIEW_FOLLOW_UP: Record<string, { approve: ActivityKind; comment: ActivityKind }> = {
  change_review: { approve: 'investigation', comment: 'change_review' },
  investigation: { approve: 'implementation', comment: 'investigation' },
};

export const MAX_ACTIVITY_RETRIES = 3;
