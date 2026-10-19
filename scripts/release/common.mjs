import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export const root = resolve(import.meta.dirname, '../..');
export const assets = ['fab-linux-x64', 'fab-linux-arm64', 'fab-darwin-x64', 'fab-darwin-arm64'];
export const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }).trim();
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
export async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export function sourceSha() { const sha = run('git', ['rev-parse', 'HEAD']); if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source SHA'); return sha; }
export async function version() { return (await readJson(resolve(root, 'package.json'))).version; }
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function junit(xml) {
  const head = /<testsuites\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const count = name => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(head)?.[1] ?? NaN);
  const tests = count('tests'), failures = count('failures'), skipped = count('skipped');
  assert(tests > 0 && failures === 0 && skipped === 0 && !/<(?:skipped|failure|error)\b/.test(xml), 'QA must have nonzero tests, no failure/skip/todo/unknown');
  return { tests, failures, skipped };
}
