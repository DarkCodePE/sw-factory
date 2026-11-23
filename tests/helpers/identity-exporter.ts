import { Store } from '../../src/store.ts';
import { exportIdentityJournal } from '../../src/users.ts';
const [db, journal, go] = process.argv.slice(2) as [string, string, string];
const s = new Store(db);
while (Date.now() < Number(go)) { /* arranque simultáneo */ }
for (let i = 0; i < 5; i++) exportIdentityJournal(s, journal);
s.close();
