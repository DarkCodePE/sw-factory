import { basename, resolve } from 'node:path';
import type { PermissionRequest, ToolCall, ToolContext, UserAnswers, UserQuestion } from './types.ts';

export function permissionRequest(call: ToolCall, input: unknown, context: ToolContext): PermissionRequest {
  const p = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const name = call.function.name, type = ({ Create: 'create', Edit: 'edit', Execute: 'execute' } as Record<string, string>)[name] ?? 'tool';
  const details: Record<string, unknown> = { type };
  if (typeof p.file_path === 'string') { details.filePath = resolve(context.cwd, p.file_path); details.fileName = basename(p.file_path); }
  if (name === 'Create') details.content = p.content;
  if (name === 'Edit') { details.oldStr = p.old_str; details.newStr = p.new_str; }
  if (name === 'Execute') details.command = p.command;
  return { toolUses: [{ toolUse: { type: 'tool_use', id: call.id, name, input }, confirmationType: type, details }],
    options: [{ label: 'Allow this call', value: 'proceed_once' }, { label: 'Cancel', value: 'cancel' }] };
}

export function parseQuestionnaire(text: string): UserQuestion[] {
  if (Buffer.byteLength(text) > 32 * 1024) throw new Error('Questionnaire exceeds 32 KiB');
  const questions: UserQuestion[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const start = /^(\d+)\.\s*\[question\]\s*(.+)$/.exec(line.trim());
    if (start) { questions.push({ index: Number(start[1]), question: start[2]!, topic: '', options: [] }); continue; }
    const current = questions.at(-1), field = /^\[(topic|option)\]\s*(.+)$/.exec(line.trim());
    if (!current || !field) throw new Error('Invalid questionnaire format');
    if (field[1] === 'topic') current.topic = field[2]!; else current.options.push(field[2]!);
  }
  if (!questions.length || questions.length > 8 || new Set(questions.map(q => q.index)).size !== questions.length ||
      questions.some(q => !q.index || q.options.length > 10 || !q.topic)) throw new Error('Invalid questionnaire questions');
  return questions;
}

export function formatAnswers(questions: UserQuestion[], result: UserAnswers): string {
  if (!result || typeof result !== 'object' || !Array.isArray(result.answers)) throw new Error('Invalid user answer response');
  if (result.cancelled) return 'User cancelled the questionnaire.';
  const indices = new Set<number>();
  for (const a of result.answers) {
    const q = questions.find(q => q.index === a?.index);
    if (!q || q.question !== a.question || typeof a.answer !== 'string' || indices.has(a.index) || Buffer.byteLength(a.answer) > 16 * 1024) throw new Error('Invalid questionnaire answer');
    indices.add(a.index);
  }
  if (result.answers.length !== questions.length) throw new Error('Questionnaire has unanswered questions');
  return questions.map(q => `${q.index}. [question] ${q.question}\n[answer] ${result.answers.find(a => a.index === q.index)!.answer}`).join('\n');
}
