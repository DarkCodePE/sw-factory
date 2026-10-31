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

// Merge uses the same in_progress activity exclusion as workers (07). The reservation
// has a non-expiring worker lease: only another merge can recover it after its owner dies,
// so requeueOrphans cannot accidentally dispatch a Git operation to an agent.
import { randomUUID } from 'node:crypto';
import { Store, StoreError } from '../store.ts';
import { gitEvidence, writeManifest } from '../manifest.ts';
import { branchFor, GIT_SAFE_FLAGS, removeWorktree } from '../worktrees.ts';

function ownerAlive(worker: string | null): boolean {
  const match = /^merge:(\d+)$/.exec(worker ?? '');
  if (!match) return true;
  try { process.kill(Number(match[1]), 0); return true; } catch (e: any) { return e.code !== 'ESRCH'; }
}

export async function mergeRecoverably(store: Store, stateDir: string, changeId: string, force = false): Promise<string> {
  const worker = `merge:${process.pid}`;
  const lock = store.db.transaction(() => {
    const c = store.getChange(changeId);
    if (c.status !== 'implemented' && c.status !== 'completed') {
      throw new StoreError('invalid_transition', `change is ${c.status}, not implemented`);
    }
    const active = store.listActivities({ changeId }).filter(a => a.status === 'in_progress');
    for (const a of active) {
      if (!a.workerId?.startsWith('merge:') || ownerAlive(a.workerId)) {
        throw new StoreError('conflict', 'change tiene una operación en curso');
      }
      store.db.query("UPDATE activities SET status = 'canceled', error = 'interrupted merge owner exited', lease_expires_at = NULL, completed_at = ? WHERE id = ?").run(store.now(), a.id);
    }
    const blocked = mergeBlocker(store.validationSummary(c.id));
    if (blocked && !force && c.status !== 'completed') {
      throw new StoreError('invalid_transition', `${blocked}; usa --force para fusionar igualmente`);
    }
    const id = randomUUID();
    store.db.query(`INSERT INTO activities (id,workstream_id,change_id,kind,status,worker_id,created_at,started_at,lease_expires_at)
      VALUES (?,?,?,'steward','in_progress',?,?,?,'9999-12-31T23:59:59.999Z')`).run(id, c.workstreamId, c.id, worker, store.now(), store.now());
    if (force) store.event(c.workstreamId, 'warning', `merge --force${blocked ? `: ${blocked}` : ''}`, c.id);
    return id;
  }).immediate();

  let failure: string | null = null;
  try {
    const c = store.getChange(changeId);
    const ws = store.getWorkstream(c.workstreamId);
    const branch = c.branch ?? branchFor(c.id);
    const events = store.db.query("SELECT message FROM events WHERE change_id = ? AND message LIKE 'merge_started %' ORDER BY id DESC LIMIT 1").get(c.id) as { message: string } | null;
    const previous = events ? JSON.parse(events.message.slice('merge_started '.length)) as { head: string; branch: string; target: string } : null;
    const target = gitEvidence(ws.repo, 'symbolic-ref', '-q', 'HEAD');
    if (!target || previous && previous.target !== target) throw new Error('merge exige la rama destino original');
    const branchHead = gitEvidence(ws.repo, 'rev-parse', '--verify', `refs/heads/${branch}`);
    const head = previous?.head ?? branchHead;
    if (!head || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error('no hay SHA de merge recuperable');
    if (previous && branchHead && branchHead !== previous.head) throw new Error('rama de change cambió desde merge_started');
    if (!previous) store.event(ws.id, 'info', `merge_started ${JSON.stringify({ head, branch, target })}`, c.id, lock);
    const ancestor = Bun.spawnSync(['git', ...GIT_SAFE_FLAGS, 'merge-base', '--is-ancestor', head, 'HEAD'], { cwd: ws.repo });
    let output = 'merge recuperado: rama ya fusionada';
    if (ancestor.exitCode !== 0) {
      if (c.status === 'completed') throw new Error('change completado pero SHA ausente del destino');
      const p = Bun.spawn(['git', ...GIT_SAFE_FLAGS, 'merge', '--no-edit', head], { cwd: ws.repo, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`git merge: ${err.trim() || out.trim()}`);
      output = out.trim();
    }
    // Persist branch HEAD before cleanup removes the ref; recovery also has merge_started.
    writeManifest(store, c.id, stateDir);
    await removeWorktree(ws.repo, stateDir, c.id);
    if (c.status !== 'completed') store.closeChange(c.id, 'completed');
    store.event(ws.id, 'info', 'merge_completed', c.id, lock);
    return output;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    store.db.query("UPDATE activities SET status = ?, error = ?, completed_at = ? WHERE id = ? AND worker_id = ?").run(failure ? 'failed' : 'completed', failure, store.now(), lock, worker);
    writeManifest(store, changeId, stateDir);
  }
}
