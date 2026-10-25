import type { Database } from 'bun:sqlite';
import type { ChangeLinkLookup, ChangeLinks, ExternalRef, PullRequestRef } from './types.ts';

type Row = { change_id: string; source_system: 'jira' | null; source_key: string | null; source_url: string | null; pr_json: string | null };

export class ChangeLinkStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS change_links (
      change_id TEXT PRIMARY KEY REFERENCES changes(id) ON DELETE CASCADE,
      source_system TEXT, source_key TEXT, source_url TEXT, pr_json TEXT,
      UNIQUE(source_system, source_key));
      CREATE TABLE IF NOT EXISTS jira_imports (
        issue_key TEXT PRIMARY KEY, signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE, source_url TEXT);`);
    const columns = db.query('PRAGMA table_info(jira_imports)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'source_url')) db.exec('ALTER TABLE jira_imports ADD COLUMN source_url TEXT');
  }

  setSource(changeId: string, ref: ExternalRef): void {
    const current = this.get(changeId)?.source;
    if (current && (current.system !== ref.system || current.key !== ref.key)) throw new Error('La HU de origen de un change no se puede reemplazar');
    const reserved = this.db.query(`SELECT s.change_id FROM jira_imports i JOIN signals s ON s.id=i.signal_id
      WHERE i.issue_key=?`).get(ref.key) as { change_id: string | null } | null;
    if (reserved && reserved.change_id !== changeId) throw new Error(`HU ${ref.key} reservada para su signal de origen`);
    const existing = this.findBySource(ref.system, ref.key);
    if (existing && existing.changeId !== changeId) throw new Error(`HU ${ref.key} ya enlazada a otro change`);
    this.db.query(`INSERT INTO change_links(change_id,source_system,source_key,source_url) VALUES (?,?,?,?)
      ON CONFLICT(change_id) DO UPDATE SET source_system=excluded.source_system, source_key=excluded.source_key, source_url=excluded.source_url`)
      .run(changeId, ref.system, ref.key, ref.url);
  }

  setPullRequest(changeId: string, pr: PullRequestRef): void {
    this.db.query(`INSERT INTO change_links(change_id,pr_json) VALUES (?,?)
      ON CONFLICT(change_id) DO UPDATE SET pr_json=excluded.pr_json`).run(changeId, JSON.stringify(pr));
  }

  get(changeId: string): ChangeLinks | undefined {
    const row = this.db.query('SELECT * FROM change_links WHERE change_id = ?').get(changeId) as Row | null;
    // A signal may be triaged by the existing CLI, outside the connector intake path.
    const imported = this.db.query(`SELECT i.issue_key, i.source_url FROM jira_imports i
      JOIN signals s ON s.id=i.signal_id WHERE s.change_id=?`).get(changeId) as { issue_key: string; source_url: string | null } | null;
    const source: ExternalRef | undefined = row?.source_system && row.source_key && row.source_url
      ? { system: row.source_system, key: row.source_key, url: row.source_url }
      : imported?.source_url ? { system: 'jira', key: imported.issue_key, url: imported.source_url } : undefined;
    return row || source ? { changeId, ...(source ? { source } : {}),
      ...(row?.pr_json ? { pr: JSON.parse(row.pr_json) as PullRequestRef } : {}) } : undefined;
  }

  findBySource(system: 'jira', key: string): ChangeLinks | undefined {
    const row = this.db.query('SELECT change_id FROM change_links WHERE source_system = ? AND source_key = ?').get(system, key) as { change_id: string } | null;
    if (row) return this.get(row.change_id);
    const imported = this.db.query(`SELECT s.change_id FROM jira_imports i JOIN signals s ON s.id=i.signal_id
      WHERE i.issue_key=? AND s.change_id IS NOT NULL`).get(key) as { change_id: string } | null;
    const linked = imported ? this.get(imported.change_id) : undefined;
    return linked?.source?.system === system && linked.source.key === key ? linked : undefined;
  }

  // Also retain imports that have not been triaged yet, without changing the shared Store.
  importedSignal(key: string): string | undefined {
    return (this.db.query('SELECT signal_id FROM jira_imports WHERE issue_key = ?').get(key) as { signal_id: string } | null)?.signal_id;
  }

  recordImport(key: string, signalId: string, sourceUrl: string): void {
    this.db.query('INSERT INTO jira_imports(issue_key,signal_id,source_url) VALUES (?,?,?)').run(key, signalId, sourceUrl);
  }

  readonly lookup: ChangeLinkLookup = changeId => this.get(changeId);
}
