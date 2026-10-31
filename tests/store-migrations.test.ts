import { expect, spyOn, test } from 'bun:test';

import { Store } from '../src/store.ts';

// Invoke the existing startup migration without exposing it as a public API.
function migrate(store: Store): void {
  (store as unknown as { migrate(): void }).migrate();
}

test('migration tolerates a column added after the schema check and can run again', () => {
  const store = new Store(':memory:');
  // The column already exists, but this reader sees the snapshot from before
  // another opener added it. ALTER then raises a real SQLite duplicate error.
  const query = spyOn(store.db, 'query').mockReturnValueOnce({ all: () => [] } as any);
  try {
    expect(() => migrate(store)).not.toThrow();
    query.mockRestore();
    expect(() => migrate(store)).not.toThrow();
    const cols = store.db.query('PRAGMA table_info(activities)').all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'validator')).toHaveLength(1);
  } finally {
    query.mockRestore();
    store.close();
  }
});

test('migration propagates errors other than duplicate columns', () => {
  const store = new Store(':memory:');
  const query = spyOn(store.db, 'query').mockReturnValueOnce({ all: () => [] } as any);
  const error = new Error('database is locked');
  const exec = spyOn(store.db, 'exec').mockImplementationOnce(() => { throw error; });
  try {
    expect(() => migrate(store)).toThrow(error);
  } finally {
    exec.mockRestore();
    query.mockRestore();
    store.close();
  }
});
