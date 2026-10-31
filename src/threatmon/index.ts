// Threat monitor implementation for captured agent output.
// Cites and adapts internal/threatmon/threatmon.go (ESF, MIT License)
//
// Límite declarado / Post-hoc limitation:
// Este monitor opera de forma post-hoc sobre la salida capturada (stdout, stderr, diff)
// tras finalizar la ejecución del agente. Detecta comportamientos fuera de límites u
// ofensivos para poner el change en cuarentena ('quarantined') antes de validación, pero
// NO puede revertir ni evitar efectos secundarios ya ocurridos en el host si el agente
// corrió sin aislamiento previo (p. ej. con agy). La mitigación de fondo de H1 es envolver
// los CLIs en sandboxes de egress, fuera de este plan.

import { defaultRules, severityRank, type ThreatRule, type ThreatSeverity } from './rules.ts';

export { defaultRules, severityRank, type ThreatRule, type ThreatSeverity } from './rules.ts';

export const RulesetVersion = '1';
export const MAX_EXCERPT_BYTES = 200;

export interface Finding {
  rule_id: string;
  category: string;
  severity: ThreatSeverity;
  stream: string;
  line: number;
  excerpt: string;
}

export interface ThreatReport {
  ruleset_version: string;
  scanned_lines: number;
  findings: Finding[];
  tripped: boolean;
  max_severity?: ThreatSeverity;
}

/**
 * Splits text into logical lines, joining lines with trailing backslashes.
 * A single trailing newline terminates the last line instead of starting an empty one.
 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1) + (lines[i + 1] ?? '');
      i++;
    }
    joined.push(line);
  }
  return joined;
}

/**
 * Fast path check: whether line contains any control bytes or escape codes requiring normalization.
 */
function needsNormalization(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes a line by removing ANSI escape sequences, dropping carriage returns,
 * and replacing other C0 control characters and DEL with spaces.
 */
export function normalizeLine(line: string): string {
  if (!needsNormalization(line)) {
    return line;
  }
  let res = '';
  for (let i = 0; i < line.length; ) {
    const c = line.charCodeAt(i);
    if (c === 0x1b) {
      // ANSI escape sequence
      i++;
      if (i < line.length && (line[i] === '[' || line[i] === ']')) {
        i++;
        while (i < line.length && (line.charCodeAt(i) < 0x40 || line.charCodeAt(i) > 0x7e)) {
          i++;
        }
        if (i < line.length) {
          i++;
        }
      }
    } else if (c === 0x0d) {
      // '\r' dropped
      i++;
    } else if (c < 0x20 || c === 0x7f) {
      // C0 control byte or DEL replaced with space
      res += ' ';
      i++;
    } else {
      res += line[i];
      i++;
    }
  }
  return res;
}

/**
 * Bounds an excerpt to at most MAX_EXCERPT_BYTES, truncating cleanly on UTF-8 rune boundaries.
 * Replaces newlines and tabs with spaces.
 */
export function makeExcerpt(s: string): string {
  s = s.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\t/g, ' ');
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  if (bytes.length <= MAX_EXCERPT_BYTES) {
    return s;
  }
  const maxBytes = MAX_EXCERPT_BYTES - 3; // room for '...'
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) {
    cut--;
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes.subarray(0, cut)) + '...';
}

/**
 * Validates a ruleset strictly: checks for empty IDs, duplicates, nil patterns, and invalid severities.
 */
export function validateRules(rules: ThreatRule[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r) continue;
    if (!r.id || !r.id.trim()) {
      throw new Error(`threatmon: rule at index ${i} has an empty ID`);
    }
    if (seen.has(r.id)) {
      throw new Error(`threatmon: duplicate rule ID "${r.id}" (index ${i})`);
    }
    seen.add(r.id);
    if (!r.pattern) {
      throw new Error(`threatmon: rule "${r.id}" has a nil pattern`);
    }
    if (severityRank(r.severity) === 0) {
      throw new Error(`threatmon: rule "${r.id}" has invalid severity "${r.severity}"`);
    }
  }
}

/**
 * Monitor accumulates findings across incremental observe calls.
 */
export class ThreatMonitor {
  private rules: ThreatRule[];
  private tripSeverity: ThreatSeverity;
  private lines: Map<string, number> = new Map();
  private findings: Finding[] = [];
  private scannedLines = 0;

  constructor(rules: ThreatRule[] = defaultRules(), tripSeverity: ThreatSeverity = 'HIGH') {
    const accepted: ThreatRule[] = [];
    const seen = new Set<string>();
    for (const r of rules) {
      const id = r.id ? r.id.trim() : '';
      if (!id || seen.has(id) || !r.pattern || severityRank(r.severity) === 0) {
        continue;
      }
      seen.add(id);
      accepted.push(r);
    }
    this.rules = accepted;
    this.tripSeverity = tripSeverity;
  }

  observe(stream: string, text: string): void {
    if (!text) return;
    for (const raw of splitLines(text)) {
      const line = normalizeLine(raw);
      this.scannedLines++;
      const currentStreamLines = (this.lines.get(stream) ?? 0) + 1;
      this.lines.set(stream, currentStreamLines);

      for (const rule of this.rules) {
        // Reset lastIndex in case a regex has state
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (!match || match.index === undefined) {
          continue;
        }
        const excerpt = makeExcerpt(line.slice(match.index));
        this.findings.push({
          rule_id: rule.id,
          category: rule.category,
          severity: rule.severity,
          stream,
          line: currentStreamLines,
          excerpt,
        });
      }
    }
  }

  report(): ThreatReport {
    const out = [...this.findings];
    out.sort((a, b) => {
      if (a.stream !== b.stream) {
        return a.stream < b.stream ? -1 : 1;
      }
      if (a.line !== b.line) {
        return a.line - b.line;
      }
      return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
    });

    let maxSeverity: ThreatSeverity | undefined;
    let maxRank = 0;
    let tripped = false;
    const tripRank = severityRank(this.tripSeverity);

    for (const f of out) {
      const rank = severityRank(f.severity);
      if (rank > maxRank) {
        maxRank = rank;
        maxSeverity = f.severity;
      }
      if (rank >= tripRank) {
        tripped = true;
      }
    }

    return {
      ruleset_version: RulesetVersion,
      scanned_lines: this.scannedLines,
      findings: out,
      tripped,
      ...(maxSeverity ? { max_severity: maxSeverity } : {}),
    };
  }
}
