// Corre los tests upstream del ledger copiado (bunfig limita `bun test` a tests/). Pin: third_party/dream-machine/UPSTREAM.json
// Rutas en variable: el upstream no compila con el tsconfig estricto de fab y no se parchea.
for (const f of ['index.test.ts', 'outcomes.test.ts']) await import(`../third_party/dream-machine/ledger/${f}`);
export {};
