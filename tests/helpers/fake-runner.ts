// Runner falso para tests de runners/client.ts: habla el protocolo v1 por stdin/stdout según el escenario.
// Uso: bun fake-runner.ts <escenario> <dir-de-trabajo> [informe]. `auto`: commit si el encargo espera cambios, sin cambios si no. Registra en <dir>/transcript lo que casa escribe y en <dir>/env las variables que ve.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { receiveJob, sealResult } from '../../src/runners/bundle.ts';
import { decodeLine } from '../../src/runners/protocol.ts';

let [scenario = 'ok', dir = '.', reportText = 'hecho'] = process.argv.slice(2);
writeFileSync(join(dir, 'env'), Object.keys(process.env).join('\n'));
writeFileSync(join(dir, 'pid'), String(process.pid));
const H64 = 'c'.repeat(64);
// Cada escritura espera a que el pipe la acepte: un exit(0) inmediato truncaría las grandes.
const out = (b: string | Buffer) => new Promise<void>(r => { process.stdout.write(b, () => r()); });
const send = (o: unknown) => out(JSON.stringify(o) + '\n');
const hello = { v: 1, type: 'hello', have: [], fabSha: 'fake123', sandbox: 'bwrap', agents: { fake: { sha256: H64 } } };

let buf = Buffer.alloc(0);
const it = process.stdin[Symbol.asyncIterator]();
async function fill() { const r = await it.next(); if (r.done) return false; buf = Buffer.concat([buf, r.value]); appendFileSync(join(dir, 'transcript'), r.value); return true; }
async function line() { for (;;) { const i = buf.indexOf(10); if (i >= 0) { const l = buf.subarray(0, i).toString(); buf = buf.subarray(i + 1); return l; } if (!await fill()) return null; } }
async function bytes(n: number) { while (buf.length < n) if (!await fill()) throw new Error('eof'); const b = buf.subarray(0, n); buf = buf.subarray(n); return Buffer.from(b); }

if (scenario === 'die') process.exit(255);
if (scenario === 'v2') { await send({ ...hello, v: 2 }); process.exit(0); }
await line();
await send(hello);
if (scenario === 'check') { await line(); process.exit(0); } // espera EOF; si casa enviara el job, se vería en el transcript
if (scenario === 'hang') { Bun.spawn(['sleep', '300']); await new Promise(() => {}); }

const jl = await line();
if (jl === null) process.exit(0);
const job = decodeLine(jl, ['job'], 'home') as Extract<ReturnType<typeof decodeLine>, { type: 'job' }>;
if (scenario === 'auto') scenario = job.expectChanges ? 'ok' : 'no-change';
if (scenario === 'busy') { await send({ v: 1, type: 'error', code: 'busy', message: 'TEXTO-LIBRE-DEL-RUNNER <script>' }); process.exit(0); }
if (scenario.startsWith('refuse:')) { await send({ v: 1, type: 'error', code: scenario.slice(7), message: 'TEXTO-LIBRE-DEL-RUNNER <script>' }); process.exit(0); }
await bytes(job.promptBytes);
const bundlePath = join(dir, 'in.bundle');
writeFileSync(bundlePath, await bytes(job.bundleBytes));
const base = { v: 1, type: 'result', jobId: job.jobId, exitCode: 0, durationMs: 5, usage: null, output: reportText, head: null, bundleBytes: 0, bundleSha256: null };
await send({ v: 1, type: 'accepted', jobId: job.jobId });
if (scenario === 'lost-accepted') process.exit(0);
if (scenario === 'accepted-then-busy') { await send({ v: 1, type: 'error', code: 'busy', message: 'TEXTO-LIBRE-DEL-RUNNER' }); process.exit(0); }
const log = (s: string) => send({ v: 1, type: 'log', data: Buffer.from(s).toString('base64') });
await log('trabajando');
if (scenario === 'timed' || scenario === 'lost-after-execution' || scenario === 'double-end') {
  await log('');
  if (scenario === 'double-end') await log('');
  if (scenario === 'lost-after-execution') process.exit(0);
  await send({ ...base, usage: { costUsd: 0.123, effectiveModel: 'modelo-remoto' }, durationMs: 123_456 });
  process.exit(0);
}
if (scenario === 'lost-log') process.exit(0);
if (scenario === 'evil-log') { for (let i = 0; i < 20; i++) await send({ v: 1, type: 'log', data: Buffer.alloc(700_000, 65).toString('base64') }); await send(base); process.exit(0); }
if (scenario === 'evil-extra') { await send({ ...base, env: { X: '1' } }); process.exit(0); }
if (scenario === 'evil-usage') { await send({ ...base, usage: { costUsd: -1, inputTokens: 1, outputTokens: 1 } }); process.exit(0); }
if (scenario === 'huge-usage') { await send({ ...base, usage: { costUsd: 1e308, inputTokens: 1, outputTokens: 1 } }); process.exit(0); }
if (scenario === 'evil-line') { await out('x'.repeat(2 * 1024 * 1024) + '\n'); process.exit(0); }
if (scenario === 'evil-jobid') { await send({ ...base, jobId: 'otro' }); process.exit(0); }
if (scenario === 'evil-output') { await send({ ...base, output: 'y'.repeat(900_000) }); process.exit(0); }
if (scenario === 'no-change') { await send(base); process.exit(0); }

const root = join(dir, 'root');
const cache = join(root, 'cache', `${H64}.git`);
const clone = await receiveJob(cache, { path: bundlePath, bytes: job.bundleBytes, sha256: job.bundleSha256 }, job.head, job.jobId);
await Bun.write(join(clone, 'nuevo.txt'), 'hola desde el runner\n');
const sealed = await sealResult(cache, clone, join(root, `idx-${job.jobId}`), job.head);
if (!sealed) { await send(base); process.exit(0); }
const data = Buffer.from(await Bun.file(sealed.bundle.path).arrayBuffer());
const res = { ...base, head: sealed.sha, bundleBytes: sealed.bundle.bytes, bundleSha256: sealed.bundle.sha256 };
if (scenario === 'bundle-bad-hash') res.bundleSha256 = 'd'.repeat(64);
await send(res);
if (scenario === 'lost-bundle') { await out(data.subarray(0, Math.floor(data.length / 2))); process.exit(0); }
await out(data);
process.exit(0);
