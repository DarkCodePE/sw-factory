import type { ValidatorKind } from '../connectors/types.ts';
import { historyBlock } from '../prompts.ts';
import type { Activity, Change } from '../store.ts';

const VALIDATOR_RULES = `Rules:
- Work only inside the current directory (the change worktree).
- Do NOT edit any files in the repository.
- Do NOT run git add, git commit, git push, or touch any other branches.
- Conclude your report with:
  1. A line starting with STATUS: done (or STATUS: blocked - <reason>)
  2. A line starting with VERDICT: pass | fail | needs_human
  3. A single concise paragraph summarizing your verdict and findings immediately following the VERDICT line.`;

const CODE_REVIEW_INSTRUCTIONS = `Your task is a rigorous CODE REVIEW of the changes made on this branch against base.
1. Review the git diff and modified files for logical correctness, bugs, edge cases, and unintended regressions.
2. Verify that unit and integration tests sufficiently cover the changes, noting any missing test scenarios.
3. For any issues or defects discovered, provide exact file:line references in your findings.
4. Conclude with a clear VERDICT:
   - pass: changes are correct, clean, adequately tested, and ready for integration.
   - fail: defects, regressions, logic errors, or missing tests require revision.
   - needs_human: ambiguous requirements or design decisions requiring human attention.`;

const SECURITY_AUDIT_INSTRUCTIONS = `Your task is a comprehensive SECURITY AUDIT of the changes made on this branch against base.
1. Inspect the git diff and modified code specifically for security vulnerabilities, including:
   - Injection risks (SQL injection, command/shell injection, XSS, template injection, code evaluation).
   - Hardcoded secrets, API keys, credentials, or tokens.
   - Path traversal and arbitrary file read/write vulnerabilities.
   - Insecure permissions, improper access control, or authentication flaws.
   - Insecure dependencies or dangerous library invocations.
2. For each identified finding, specify its severity level (Critical, High, Medium, Low, Info) and exact file:line reference.
3. Conclude with a clear VERDICT:
   - pass: no security vulnerabilities or policy violations detected.
   - fail: high or critical vulnerabilities, hardcoded secrets, or dangerous injection hazards identified.
   - needs_human: acceptable security risks requiring human risk sign-off.`;

const QA_INSTRUCTIONS = `Your task is QUALITY ASSURANCE (QA) on the change in this worktree.
1. Review the change description and acceptance criteria to understand the target behavior.
2. Run the test suite and verify that all tests pass and acceptance criteria are met.
3. Include the exact test command executed and its result (pass/fail summary) in your report.
4. CRITICAL: Do NOT leave any modified, untracked, or temporary files behind. The worktree MUST remain completely clean (git status --porcelain must be empty after execution).
5. Conclude with a clear VERDICT:
   - pass: test suite passes and all acceptance criteria are verified.
   - fail: test suite failures, runtime errors, or unmet acceptance criteria.
   - needs_human: environment blockers preventing verification or ambiguous acceptance criteria.`;

export function buildValidatorPrompt(
  v: ValidatorKind,
  input: {
    change: Change;
    diffStat: string;
    base: string;
    branch: string;
    worktree: string;
    history: Activity[];
  }
): string {
  let instructions = '';
  switch (v) {
    case 'code_review':
      instructions = CODE_REVIEW_INSTRUCTIONS;
      break;
    case 'security_audit':
      instructions = SECURITY_AUDIT_INSTRUCTIONS;
      break;
    case 'qa':
      instructions = QA_INSTRUCTIONS;
      break;
    default:
      throw new Error(`unknown validator kind: ${v}`);
  }

  const diffSection = input.diffStat.trim()
    ? `## Git Diff Summary (${input.base}..${input.branch})\n\`\`\`\n${input.diffStat.trim()}\n\`\`\``
    : `## Git Diff Summary\nBranch ${input.branch} against base ${input.base}`;

  return `You are a specialized validation agent performing ${v} in a software factory.

# Change
Title: ${input.change.title}

${input.change.description}

# Context
Working directory: ${input.worktree}
Branch: ${input.branch}
Base: ${input.base}

${diffSection}

# Earlier work on this change
${historyBlock(input.history)}

# Your Validator Assignment: ${v}
${instructions}

${VALIDATOR_RULES}`;
}
