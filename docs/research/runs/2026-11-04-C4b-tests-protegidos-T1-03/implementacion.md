baseline: 2dff534e629bba57f035f8c59aa154664a6f1b8e7dd149d585fab524af7bb1b6
candidato: 64f463d95c679a4d17ab77b70f2f5a533a1ab0f5624ad987573c1fb22f4818ea

Perfiles revisados contra la spec y el perfil por defecto obtenido mediante `FABRICA_HOME=$HOME/.fabrica-ideas bun src/cli.ts profile export`. Ambos cumplían; no se modificaron. Se verificó por igualdad estructural que la única diferencia es `worker.implement`, cuyo texto coincide exactamente con el bloque de la spec. Ambos perfiles se importaron correctamente con `FABRICA_HOME=$HOME/.fabrica-ideas bun src/cli.ts profile import <archivo>`.

Diff obtenido con `diff -u perfiles/baseline.json perfiles/candidato.json` (salida 1: existen diferencias):

```diff
--- perfiles/baseline.json	2026-11-04 22:52:43.020258445 -0500
+++ perfiles/candidato.json	2026-11-04 22:52:52.414228494 -0500
@@ -4,7 +4,7 @@
   "worker": {
     "rules": "Rules:\n- Work only inside the current directory (a git worktree created for this change).\n- Do not push, open pull requests, or touch other branches; the factory handles integration.\n- Finish with a Markdown report. Its first line must be \"STATUS: done\" or \"STATUS: blocked - <reason>\".",
     "investigate": "Your task is an INVESTIGATION. Do not change any files.\n1. Reproduce or confirm the problem described in the change (run the tests or the code if that helps).\n2. Find the root cause and point to the exact files and lines involved.\n3. Write a short implementation spec: what to change, why, and how it will be verified (tests to add or run).\nIf the problem cannot be confirmed, say so and explain what you checked.",
-    "implement": "Your task is an IMPLEMENTATION of the approved spec above.\n1. Make the smallest change that satisfies the spec; follow the existing code style.\n2. Add or update tests that would have caught the problem.\n3. Run the test suite and include the command and its result in your report.\n4. Commit your work on the current branch with a clear message (git add + git commit).\nIf the spec turns out to be wrong, stop and explain instead of improvising a different change."
+    "implement": "Your task is an IMPLEMENTATION of the approved spec above.\n1. Make the smallest change that satisfies the spec; follow the existing code style.\n2. Do NOT create, modify, rename or delete protected files: tests and test configuration (tests/**, test/**, *.test.*, *.spec.*, conftest.py, pytest.ini, pyproject.toml, setup.cfg, package.json, lockfiles, tsconfig*.json, Makefile, .github/**). Instead, describe in your report the tests that would be needed (name, what each checks, expected result).\n3. Run the existing test suite WITHOUT editing it and include the command and its result in your report.\n4. Commit your work on the current branch with a clear message (git add + git commit).\nIf the spec turns out to be wrong, stop and explain instead of improvising a different change."
   },
   "validators": {
     "rules": "Rules:\n- Work only inside the current directory (the change worktree).\n- Do NOT edit any files in the repository.\n- Do NOT run git add, git commit, git push, or touch any other branches.\n- Conclude your report with:\n  1. A line starting with STATUS: done (or STATUS: blocked - <reason>)\n  2. A line starting with VERDICT: pass | fail | needs_human\n  3. A single concise paragraph summarizing your verdict and findings immediately following the VERDICT line.",
```

No se ejecutó `fab improve`, ninguna medición ni agentes. No se modificaron fuentes, suite ni validadores. La medición y el veredicto quedan a cargo del operador.

Incidencia de aislamiento: una consulta a graft solicitó excluir `src/profile.ts`, `src/prompts.ts` y los runs de investigación, pero devolvió fragmentos de esas dos fuentes citadas. Se registra esta exposición involuntaria para que el operador pueda evaluar la validez del aislamiento. No se abrieron receta.md, canonical.md, hipotesis.json ni otros runs.
