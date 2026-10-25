// Worker prompts. One prompt per activity kind; each run handles exactly one activity.
import type { Activity, Change, Workstream } from './store.ts';

interface PromptInput {
  workstream: Workstream;
  change: Change;
  activity: Activity;
  history: Activity[];
  worktree: string;
  branch: string;
}

export function historyBlock(history: Activity[]): string {
  if (history.length === 0) return 'No earlier work on this change.';
  return history
    .map((h) => {
      const parts = [`### ${h.kind} (${h.status}${h.reviewStatus ? `, review: ${h.reviewStatus}` : ''})`];
      if (h.result) parts.push(h.result.trim());
      if (h.reviewComment) parts.push(`**Reviewer comment:** ${h.reviewComment}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

const SHARED_RULES = `Rules:
- Work only inside the current directory (a git worktree created for this change).
- Do not push, open pull requests, or touch other branches; the factory handles integration.
- Finish with a Markdown report. Its first line must be "STATUS: done" or "STATUS: blocked - <reason>".`;

const INVESTIGATE = `Your task is an INVESTIGATION. Do not change any files.
1. Reproduce or confirm the problem described in the change (run the tests or the code if that helps).
2. Find the root cause and point to the exact files and lines involved.
3. Write a short implementation spec: what to change, why, and how it will be verified (tests to add or run).
If the problem cannot be confirmed, say so and explain what you checked.`;

const IMPLEMENT = `Your task is an IMPLEMENTATION of the approved spec above.
1. Make the smallest change that satisfies the spec; follow the existing code style.
2. Add or update tests that would have caught the problem.
3. Run the test suite and include the command and its result in your report.
4. Commit your work on the current branch with a clear message (git add + git commit).
If the spec turns out to be wrong, stop and explain instead of improvising a different change.`;

const IMPLEMENT_FACTORY_COMMITS = IMPLEMENT.replace(
  '4. Commit your work on the current branch with a clear message (git add + git commit).',
  '4. Do NOT run git add or git commit: leave the changes in the working tree; the factory commits them after your report.');

export function buildWorkerPrompt(p: PromptInput, opts: { factoryCommits?: boolean } = {}): string {
  const task = p.activity.kind === 'implementation' ? (opts.factoryCommits ? IMPLEMENT_FACTORY_COMMITS : IMPLEMENT) : INVESTIGATE;
  return `You are a worker in a software factory. You were assigned ONE activity on ONE change.

# Workstream goal
${p.workstream.goal}

# Change
Title: ${p.change.title}

${p.change.description}

# Earlier work on this change
${historyBlock(p.history)}

# Your activity: ${p.activity.kind}
Working directory: ${p.worktree} (branch ${p.branch})

${task}

${SHARED_RULES}`;
}

/** The first report line decides success; anything else counts as blocked. */
export function reportStatusLine(output: string): string | undefined {
  return output.split('\n').map(line => line.trim().replace(/^#{1,6}\s+/, '').replace(/\*/g, '').trim())
    .find(line => /^STATUS:/i.test(line));
}

export function validateReportStatus(output: string): string | undefined {
  const line = reportStatusLine(output);
  return line && /^STATUS:\s*(?:done\s*|blocked\s*-\s*\S.*)$/i.test(line)
    ? undefined : 'Include a first STATUS line containing exactly STATUS: done or STATUS: blocked - <reason>.';
}

export function parseReportStatus(output: string): { done: boolean; reason: string } {
  const line = reportStatusLine(output);
  if (!line) return { done: false, reason: 'report has no STATUS line' };
  if (/^STATUS:\s*done\s*$/i.test(line)) return { done: true, reason: '' };
  return { done: false, reason: line.replace(/^STATUS:\s*/i, '') };
}
