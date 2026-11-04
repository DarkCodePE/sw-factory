# Implementación — 2026-11-03-C4b-busqueda-acotada-01

Implementación de los pasos 1–3 de la especificación técnica contenida en `brief-medir.md`.

## 1. Digests de los perfiles

Los perfiles se crearon en `docs/research/runs/2026-11-03-C4b-busqueda-acotada-01/perfiles/` y se importaron en `$HOME/.fabrica-ideas`:

* **Perfil baseline** (`perfiles/baseline.json`):
  * **Digest**: `5b2122cd8fa2add45989ab94918a8927c57d0c9d6c478313baf903ab071f9351`
  * **Harness**: `claude`
  * **Model**: `claude-haiku-5-5`
  * **Canonical bytes**: 4308 bytes

* **Perfil candidato** (`perfiles/candidato.json`):
  * **Digest**: `41d3dc19bea44ae81d19f3e5d70a473c58423adda8428e4b6594c776ddb38187`
  * **Harness**: `claude`
  * **Model**: `claude-haiku-5-5`
  * **Canonical bytes**: 4635 bytes

---

## 2. Diff de JSON entre perfiles

El único cambio entre `baseline.json` y `candidato.json` es el campo `worker.implement`:

```diff
--- docs/research/runs/2026-11-03-C4b-busqueda-acotada-01/perfiles/baseline.json
+++ docs/research/runs/2026-11-03-C4b-busqueda-acotada-01/perfiles/candidato.json
@@ -5,7 +5,7 @@
   "worker": {
     "rules": "Rules:\n- Work only inside the current directory (a git worktree created for this change).\n- Do not push, open pull requests, or touch other branches; the factory handles integration.\n- Finish with a Markdown report. Its first line must be \"STATUS: done\" or \"STATUS: blocked - <reason>\".",
     "investigate": "Your task is an INVESTIGATION. Do not change any files.\n1. Reproduce or confirm the problem described in the change (run the tests or the code if that helps).\n2. Find the root cause and point to the exact files and lines involved.\n3. Write a short implementation spec: what to change, why, and how it will be verified (tests to add or run).\nIf the problem cannot be confirmed, say so and explain what you checked.",
-    "implement": "Your task is an IMPLEMENTATION of the approved spec above.\n1. Make the smallest change that satisfies the spec; follow the existing code style.\n2. Add or update tests that would have caught the problem.\n3. Run the test suite and include the command and its result in your report.\n4. Commit your work on the current branch with a clear message (git add + git commit).\nIf the spec turns out to be wrong, stop and explain instead of improvising a different change."
+    "implement": "Your task is an IMPLEMENTATION of the approved spec above.\n1. Make the smallest change that satisfies the spec; follow the existing code style.\n2. Add or update tests that would have caught the problem.\n3. Run the test suite and include the command and its result in your report.\n4. Commit your work on the current branch with a clear message (git add + git commit).\nIf the spec turns out to be wrong, stop and explain instead of improvising a different change.\n\nAntes de editar, localiza el código con búsqueda acotada: usa Grep para encontrar los símbolos o textos relevantes y Read con rango de líneas (offset y limit) para leer solo los tramos necesarios. No leas archivos enteros salvo que sean cortos. Después edita, ejecuta las pruebas y conserva el resto de estas instrucciones."
   },
   "validators": {
     "rules": "Rules:\n- Work only inside the current directory (the change worktree).\n- Do NOT edit any files in the repository.\n- Do NOT run git add, git commit, git push, or touch any other branches.\n- Conclude your report with:\n  1. A line starting with STATUS: done (or STATUS: blocked - <reason>)\n  2. A line starting with VERDICT: pass | fail | needs_human\n  3. A single concise paragraph summarizing your verdict and findings immediately following the VERDICT line.",
```

### Párrafo añadido al final de `worker.implement`:
> Antes de editar, localiza el código con búsqueda acotada: usa Grep para encontrar los símbolos o textos relevantes y Read con rango de líneas (offset y limit) para leer solo los tramos necesarios. No leas archivos enteros salvo que sean cortos. Después edita, ejecuta las pruebas y conserva el resto de estas instrucciones.

---

## 3. Comprobaciones realizadas

1. **Validación de esquema y plantillas (`validateProfile`)**:
   - `schemaVersion === 1`.
   - `harness: "claude"` (pertenece a `AGENT_NAMES`).
   - `model: "claude-haiku-5-5"` (string no vacío en ambos perfiles).
   - Claves de worker: exactamente `rules`, `investigate`, `implement` (textos no vacíos ≤ 32 KiB).
   - Claves de validadores: exactamente `rules`, `code_review`, `security_audit`, `qa` (textos no vacíos ≤ 32 KiB).
   - Preservación íntegra de `COMMIT_LINE` (`"4. Commit your work on the current branch with a clear message (git add + git commit)."`), sin alterar la numeración de los pasos existentes.
   - Preservación de las marcas obligatorias `STATUS:` y `VERDICT:`.

2. **Diferencia de un único campo**:
   - Comparación estructural de objetos JSON: únicamente `worker.implement` difiere entre el perfil baseline y el candidato. Todas las demás claves (`schemaVersion`, `harness`, `model`, `worker.rules`, `worker.investigate`, `validators.*`) son idénticas byte a byte.

3. **Importación con CLI en `$HOME/.fabrica-ideas`**:
   - `FABRICA_HOME=$HOME/.fabrica-ideas bun src/cli.ts profile import <archivo>` ejecutado exitosamente para ambos perfiles.
   - Salidas del comando:
     - Baseline: `5b2122cd8fa2add45989ab94918a8927c57d0c9d6c478313baf903ab071f9351`
     - Candidato: `41d3dc19bea44ae81d19f3e5d70a473c58423adda8428e4b6594c776ddb38187`
   - Re-importación verificada como idempotente (`(ya existía)`).

4. **Inspección e integridad direccionada por contenido**:
   - `FABRICA_HOME=$HOME/.fabrica-ideas bun src/cli.ts profile list` lista ambos digests junto al por defecto.
   - `FABRICA_HOME=$HOME/.fabrica-ideas bun src/cli.ts profile inspect <digest>` recupera y valida el JSON canónico y contenido para ambos digests.

5. **Suite de pruebas de perfiles**:
   - Ejecución de `bun test tests/profile.test.ts`: 6/6 pruebas aprobadas (0 errores).

6. **Restricciones del entorno**:
   - No se modificaron archivos en `src/`.
   - No se crearon ramas ni flags de código.
   - No se ejecutó `fab improve` ni agentes.
