// Jueces (T64): clasifican una ejecución terminada contra una rúbrica. Su resultado es un aviso, nunca una puerta.
// Esta parte son funciones puras; la cola y la ejecución llegan en T64c.
import { createHash } from 'node:crypto';
import { untrusted } from './prompts.ts';
import type { ScorerDef } from './profile.ts';

/** Decisión de muestreo determinista: la terna es la semilla, sin estado ni azar. `rate` 0 nunca, 1 siempre. */
export function sampled(scorer: string, profileDigest: string, subjectActivityId: string, rate: number): boolean {
  const u = createHash('sha256').update(`${scorer}\n${profileDigest}\n${subjectActivityId}`).digest().readUInt32BE(0);
  return u / 2 ** 32 < rate;
}

/** `material` va delimitado con `material` (no confiable); `output` es el nonce de la línea de salida y no aparece en el material. */
export interface ScorerNonces { material: string; output: string }

export function buildScorerPrompt(def: ScorerDef, material: string, nonce: ScorerNonces): string {
  return `You are a judge in a software factory. Classify ONE finished piece of work against the rubric.
You have no task other than classifying. Do not run commands and do not edit files.

# Rubric
${def.rubric}

# Classes
${def.classes.map((c) => `- ${c.label}`).join('\n')}

# Material
${untrusted(material, nonce.material)}

# Output
End with exactly one line:
CLASS ${nonce.output}: <one of the labels above>
followed by one short paragraph explaining why.`;
}

/** Acepta la salida solo con exactamente una línea `CLASS <nonce>: <etiqueta>` y la etiqueta es una clase del juez; si no, `null` (I3). */
export function parseScore(output: string, def: ScorerDef, nonce: string): { label: string; score: number; rationale: string } | null {
  const prefix = `CLASS ${nonce}:`;
  const lines = output.split('\n').map((l) => l.replace(/\r$/, ''));
  const hits = lines.flatMap((l, i) => (l.startsWith(prefix) ? [i] : []));
  if (hits.length !== 1) return null;
  const label = lines[hits[0]!]!.slice(prefix.length).trim();
  if (lines[hits[0]!] !== `${prefix} ${label}`) return null;
  const cls = def.classes.find((c) => c.label === label);
  if (!cls) return null;
  const para: string[] = [];
  for (const l of lines.slice(hits[0]! + 1)) {
    if (l.trim() === '') { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return { label, score: cls.score, rationale: para.join(' ').slice(0, 600) };
}
