import { mkdirSync } from 'node:fs';

/** Único sitio donde fab crea su estado: 0700 aunque la umask sea abierta (T96-H1/H8), o los adjuntos se rechazan y los tokens quedan legibles. */
export function ensureStateDir(dir: string): void { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
