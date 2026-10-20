#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { ensureBinary } from '../runtime.mjs';
import { fileURLToPath } from 'node:url';
try {
  const binary = await ensureBinary();
  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, FAB_NPM_PACKAGE_ROOT: fileURLToPath(new URL('../', import.meta.url)) } });
  const forward = signal => () => child.kill(signal);
  const interrupt = forward('SIGINT'), terminate = forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  child.on('error', error => { console.error(`FAB: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  });
} catch (error) { console.error(`FAB: ${error.message}`); process.exitCode = 1; }
