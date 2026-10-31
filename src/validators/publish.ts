import type { ChangeLinkLookup, PullRequestGateway, ValidationSummary } from '../connectors/types.ts';

/**
 * Generates a Markdown summary table of validator results.
 */
export function validationMarkdown(summary: ValidationSummary): string {
  const shortId = summary.changeId.slice(0, 8);
  const statusEmoji = summary.passed ? 'APROBADO' : summary.pending ? 'PENDIENTE' : 'FALLIDO';

  const rows = summary.results.map((r) => {
    const verdict = r.verdict ? `**${r.verdict.toUpperCase()}**` : r.failed ? '*sin veredicto (falló)*' : '*pendiente*';
    const cleanSummary = (r.summary || '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    return `| \`${r.validator}\` | ${verdict} | ${cleanSummary} |`;
  });

  return [
    `### Validación de fab change \`${shortId}\` [${statusEmoji}]`,
    '',
    '| Validador | Veredicto | Resumen |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Why `fab merge` must stop: validators pending/running, missing verdicts or any `fail` verdict.
 * Changes that never requested validation merge as before.
 */
export function mergeBlocker(summary: ValidationSummary): string | undefined {
  if (summary.pending) return 'hay validadores pendientes o en curso';
  const failed = summary.results.filter((r) => r.verdict === 'fail').map((r) => r.validator);
  if (failed.length) return `validadores en fail: ${failed.join(', ')}`;
  // No validators are pending/running, so an absent verdict is terminal.
  const missing = summary.results.filter((r) => r.verdict === undefined).map((r) => r.validator);
  return missing.length ? `validadores sin veredicto: ${missing.join(', ')}` : undefined;
}

/**
 * Publishes the validation summary as a comment on the linked Pull Request.
 */
export async function publishValidation(
  summary: ValidationSummary,
  deps: { lookup: ChangeLinkLookup; prs: PullRequestGateway }
): Promise<'published' | 'no_pr'> {
  const links = deps.lookup(summary.changeId);
  if (!links || !links.pr) {
    return 'no_pr';
  }
  const markdown = validationMarkdown(summary);
  await deps.prs.comment(links.pr, markdown);
  return 'published';
}
