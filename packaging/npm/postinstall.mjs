import { ensureBinary } from './runtime.mjs';
try { console.log(`FAB instalado: ${await ensureBinary()}`); }
catch (error) { console.error(`FAB: ${error.message}`); process.exitCode = 1; }
