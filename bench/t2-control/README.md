# Brazo de control T2

`control.json` parte de `defaultProfile()` y sustituye exclusivamente los pasos 2 y 3 de `worker.implement` por instrucciones sobre el mensaje de commit, nombres, formato y comentarios. No se importa ni activa automáticamente.

Referencia: `docs/research/runs/2026-11-04-C4b-tests-protegidos-T1-03/perfiles/candidato.json`.

Aproximación declarada de tokens: **caracteres Unicode / 4**, contando solo los dos pasos sustituidos, incluidos sus números y el salto de línea. Candidato: 456 caracteres (114 tokens aproximados); control: 450 (112,5), diferencia −1,32 %. Como comprobación adicional: 63 palabras frente a 64 (+1,59 %). No se usa un tokenizer específico del proveedor ni se afirma igualdad exacta de tokens reales. El resto del perfil permanece idéntico al actual perfil por defecto.

Validación reproducible desde la raíz:

```sh
bun bench/t2-control/validate.ts
bun test tests/t2-control.test.ts
```

El validador exige igualdad completa con el perfil por defecto tras sustituir esos pasos, longitud dentro de ±5 % y ausencia de vocabulario sobre tests, protección o verificación en el texto nuevo. Falla si cambia el perfil por defecto o la referencia fuera de estas condiciones.
