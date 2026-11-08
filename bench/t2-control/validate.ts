#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { defaultProfile } from '../../src/profile.ts';

const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export function validarControl() {
  const control = load('./control.json');
  const candidate = load('../../docs/research/runs/2026-11-04-C4b-tests-protegidos-T1-03/perfiles/candidato.json');
  const baseline = defaultProfile();
  const steps = /^2\. [^\n]*\n3\. [^\n]*/m;
  const replacement = control.worker.implement.match(steps)?.[0];
  const reference = candidate.worker.implement.match(steps)?.[0];
  if (!replacement || !reference) throw new Error('faltan pasos 2–3');
  baseline.worker.implement = baseline.worker.implement.replace(steps, replacement);
  if (JSON.stringify(baseline) !== JSON.stringify(control)) throw new Error('control difiere del perfil por defecto fuera de pasos 2–3');
  if (/test|prueba|protect|proteg|verif/i.test(replacement)) throw new Error('control menciona contenido excluido');
  // Proxy explícito de tokens: caracteres Unicode / 4. No es un tokenizer de proveedor.
  const tokens = (s: string) => Array.from(s).length / 4;
  const ratio = tokens(replacement) / tokens(reference);
  if (Math.abs(ratio - 1) > 0.05) throw new Error(`longitud fuera de ±5 %: ${ratio}`);
  return { aproximacion: 'caracteres Unicode / 4, pasos 2–3', control: tokens(replacement), candidato: tokens(reference), ratio };
}
if (import.meta.main) console.log(JSON.stringify(validarControl(), null, 2));
