// Repository search for workers and the CLI: fuzzy file finding and content grep via fff
// (MIT, @ff-labs/fff-bun), with a ripgrep fallback when the native library is unavailable.
import { resolve } from 'node:path';

export interface FileHit {
  path: string;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchBackend {
  name: 'fff' | 'rg';
  files(query: string, limit?: number): Promise<FileHit[]>;
  grep(pattern: string, limit?: number): Promise<GrepHit[]>;
  close(): void;
}

async function fffBackend(root: string): Promise<SearchBackend | null> {
  try {
    const { FileFinder } = await import('@ff-labs/fff-bun');
    const created = FileFinder.create({ basePath: root });
    if (!created.ok) return null;
    const finder = created.value;
    await finder.waitForScan(10_000);
    return {
      name: 'fff',
      async files(query, limit = 50) {
        const r = finder.fileSearch(query);
        if (!r.ok) throw new Error(`fff search failed: ${String(r.error)}`);
        return r.value.items.slice(0, limit).map((i) => ({ path: i.relativePath }));
      },
      async grep(pattern, limit = 100) {
        const r = finder.grep(pattern);
        if (!r.ok) throw new Error(`fff grep failed: ${String(r.error)}`);
        return r.value.items.slice(0, limit).map((i) => ({ path: i.relativePath, line: i.lineNumber, text: i.lineContent }));
      },
      close: () => finder.destroy(),
    };
  } catch {
    return null;
  }
}

async function run(argv: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'ignore' });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out;
}

function rgBackend(root: string): SearchBackend {
  return {
    name: 'rg',
    async files(query, limit = 50) {
      const all = (await run(['rg', '--files'], root)).split('\n').filter(Boolean);
      const q = query.toLowerCase();
      return all.filter((p) => p.toLowerCase().includes(q)).slice(0, limit).map((path) => ({ path }));
    },
    async grep(pattern, limit = 100) {
      // `--` stops option parsing so a pattern starting with "-" cannot inject rg flags.
      const out = await run(['rg', '--line-number', '--no-heading', '--fixed-strings', '--max-count', '20', '--', pattern], root);
      return out
        .split('\n')
        .filter(Boolean)
        .slice(0, limit)
        .map((l) => {
          const m = /^(.*?):(\d+):(.*)$/.exec(l);
          return m ? { path: m[1]!, line: Number(m[2]), text: m[3]! } : { path: l, line: 0, text: '' };
        });
    },
    close: () => {},
  };
}

/** Open the best available backend for a repository root. */
export async function openSearch(root: string, prefer: 'fff' | 'rg' = 'fff'): Promise<SearchBackend> {
  const abs = resolve(root);
  if (prefer === 'fff') {
    const fff = await fffBackend(abs);
    if (fff) return fff;
  }
  return rgBackend(abs);
}
