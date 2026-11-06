// One paid worker, then the hidden verifier in the parent. No experiment arms.
// ANTHROPIC_MODEL=claude-haiku-5-5 bun bench/t1-filtro/smoke-confine.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, runAgent } from '../../src/agents.ts';
import { verifierArgv } from '../../src/agent/mission-evidence.ts';
const root = mkdtempSync('/tmp/fab-p6b-normal-');
const repo = join(root, 'repo');
const prepare = Bun.spawnSync(['bash', 'bench/t0-humo/prepare.sh', repo]);
if (prepare.exitCode) throw new Error(prepare.stderr.toString());
const task = JSON.parse(readFileSync(join(repo, 'suite.json'), 'utf8')).tasks[0];
// The parent keeps the suite, including verify, outside the mounted worktree.
Bun.spawnSync(['mv', join(repo, 'suite.json'), join(root, 'suite.json')]);
const base = getAgent('claude');
const adapter = { ...base, command: (p: string) => [...base.command(p), '--max-budget-usd', '0.015'] };
const run = await runAgent(adapter, `${task.description} No modifiques tests existentes. Finaliza con STATUS: done.`, repo, 90_000, { confine: true });
const verify = Bun.spawnSync(verifierArgv(task.verify), { cwd: repo });
const evidence = { root, confine: true, model: process.env.ANTHROPIC_MODEL, task: task.id, run,
  verify: { command: task.verify, exitCode: verify.exitCode, stdout: verify.stdout.toString(), stderr: verify.stderr.toString() },
  code: readFileSync(join(repo, 'calc.py'), 'utf8') };
writeFileSync('bench/t1-filtro/evidence/p6b-smoke.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ success: verify.exitCode === 0, costUsd: run.usage?.costUsd, root }));
if (!run.ok || verify.exitCode !== 0) process.exitCode = 1;
