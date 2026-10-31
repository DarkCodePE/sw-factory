import type { ValidationVerdict } from '../connectors/types.ts';

/**
 * Parses the VERDICT line and summary from a validator's report.
 *
 * Expected format:
 * VERDICT: pass|fail|needs_human
 *
 * Following the VERDICT line, the first non-empty paragraph is extracted as
 * the summary and truncated to 600 characters.
 */
export function parseVerdict(report: string): { verdict: ValidationVerdict; summary: string } | undefined {
  if (!report) return undefined;
  const lines = report.split('\n');
  let verdictLineIdx = -1;
  let verdict: ValidationVerdict | undefined = undefined;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // Tolerate markdown headings (#), bold/italic asterisks (*), and extra spaces
    const cleaned = rawLine.replace(/^#{1,6}\s+/, '').replace(/\*/g, '').trim();
    const match = /^VERDICT:\s*(pass|fail|needs_human)\b/i.exec(cleaned);
    if (match) {
      verdict = match[1]!.toLowerCase() as ValidationVerdict;
      verdictLineIdx = i;
      break;
    }
  }

  if (!verdict || verdictLineIdx === -1) {
    return undefined;
  }

  const subsequentLines = lines.slice(verdictLineIdx + 1);
  let inParagraph = false;
  const paragraphLines: string[] = [];

  for (const line of subsequentLines) {
    const trimmed = line.trim();
    if (!inParagraph) {
      if (trimmed.length > 0) {
        inParagraph = true;
        paragraphLines.push(trimmed);
      }
    } else {
      if (trimmed.length === 0) {
        break;
      }
      paragraphLines.push(trimmed);
    }
  }

  const summary = paragraphLines.join('\n').slice(0, 600);
  return { verdict, summary };
}
