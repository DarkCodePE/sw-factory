baseline: 2dff534e629bba57f035f8c59aa154664a6f1b8e7dd149d585fab524af7bb1b6
candidato: 7e203665b204963bc007e3843b0ddae41d5a924df1e9f7069d0541a954b45846

```diff
--- perfiles/baseline.json	2026-11-04 00:12:21.931718977 -0500
+++ perfiles/candidato.json	2026-11-04 00:12:27.227709454 -0500
@@ -4,7 +4,7 @@
   "worker": {
     "rules": "Rules:\n- Work only inside the current directory (a git worktree created for this change).\n- Do not push, open pull requests, or touch other branches; the factory handles integration.\n- Finish with a Markdown report. Its first line must be \"STATUS: done\" or \"STATUS: blocked - <reason>\".",
     "investigate": "Your task is an INVESTIGATION. Do not change any files.\n1. Reproduce or confirm the problem described in the change (run the tests or the code if that helps).\n2. Find the root cause and point to the exact files and lines involved.\n3. Write a short implementation spec: what to change, why, and how it will be verified (tests to add or run).\nIf the problem cannot be confirmed, say so and explain what you checked.",
-    "implement": "Your task is an IMPLEMENTATION of the approved spec above.\n1. Make the smallest change that satisfies the spec; follow the existing code style.\n2. Add or update tests that would have caught the problem.\n3. Run the test suite and include the command and its result in your report.\n4. Commit your work on the current branch with a clear message (git add + git commit).\nIf the spec turns out to be wrong, stop and explain instead of improvising a different change."
+    "implement": "Your task is an IMPLEMENTATION of the approved spec above.\n1. Make the smallest change that satisfies the spec; follow the existing code style.\n2. Do not modify protected files (tests/** and test configuration such as conftest.py, pytest.ini, package.json). Instead, describe in your final report the tests that would be needed.\n3. Run the test suite and include the command and its result in your report.\n4. Commit your work on the current branch with a clear message (git add + git commit).\nIf the spec turns out to be wrong, stop and explain instead of improvising a different change."
   },
   "validators": {
     "rules": "Rules:\n- Work only inside the current directory (the change worktree).\n- Do NOT edit any files in the repository.\n- Do NOT run git add, git commit, git push, or touch any other branches.\n- Conclude your report with:\n  1. A line starting with STATUS: done (or STATUS: blocked - <reason>)\n  2. A line starting with VERDICT: pass | fail | needs_human\n  3. A single concise paragraph summarizing your verdict and findings immediately following the VERDICT line.",
```
