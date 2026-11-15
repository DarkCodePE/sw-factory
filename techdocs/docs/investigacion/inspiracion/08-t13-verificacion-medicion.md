# 08 · T13: verificación de la medición en `fab resident report`

T13 no construye el router de la fase 3: mide si hace falta. Esta página recoge la verificación independiente de sus dos tareas antes de abrir el PR.

- **T13-a** añade tres mediciones al informe: `followupsLost`, `stopsLost` y `unlabeledTrusted`.
- **T13-b** evita que `fab resident report` cree las tablas `adm_*` en una base que nunca usó la admisión.

!!! warning "Veredicto: listo con cambios"
    El código cumple al pie de la letra las definiciones del encargo y los seis tests nuevos fallan sin el cambio. No hay bloqueos de corrección.

    Antes del PR conviene cerrar H3 y H4, que son pequeños, y decidir qué hacer con H1: es un defecto de la definición, no del código.

| | |
|---|---|
| Verificador | Claude Fable 5.2, sin contexto previo y en solo lectura |
| Fecha | 2026-11-13 |
| Código revisado | rama `feat/t13-router`, commits `0729e40` y `4b5ec6d` sobre `release/0.1.0-rc.12` |
| Encargo | §4 de `docs/research/superagent-vs-fab/t13/analisis-fable.md` |
| Informe completo | `docs/research/superagent-vs-fab/t13/verif-fable.md`, con las citas `ruta:línea` y la marca de verificado o inferido en cada afirmación |
| Informe del implementador | `docs/research/superagent-vs-fab/t13/impl-codex.md` |

Las mutaciones y las sondas se ejecutaron en una copia temporal de la rama. Lo que depende de un ciclo real del residente contra GitHub sale de leer `resident.ts`, no de ejecutarlo.

---

## 1. Qué se comprobó

| Punto | Resultado |
|---|---|
| Definiciones | Las tres mediciones cumplen el encargo: orden por `decided_at` y `trigger_key`, una fila por hilo con la más antigua que cumple, `admittedAt` como la primera decisión `would_admit`, y etiqueta comparada sin mayúsculas con la política guardada en la propia fila. |
| Regresión del informe | No se pierden decisiones en una base real: la clave foránea está activa, nada borra triggers y los comentarios no tienen fila en `adm_decisions`. |
| Texto no confiable | El cuerpo de los comentarios queda fuera: el informe no consulta `adm_comments`. La salida de texto no filtra caracteres de control (H5); `--json` sí los escapa. |
| T13-b | `report` y `report --json` sobre una base nueva no crean tablas. Las demás rutas de lectura ya estaban protegidas por `hasAdmission`. |
| Tests | Con el código anterior, los seis tests nuevos fallan. De 26 mutaciones mueren 21. |
| Alcance | El diff toca solo `src/admission/cli.ts`, `src/admission/report.ts` y su test. Nada de la lista «no tocar». |

## 2. Hallazgos

### H1 · `stopsLost` cuenta cierres normales y queda vacía en `observe` (media)

Es un defecto de la definición del encargo, no de la implementación.

- **En `auto`:** cuando la fab termina un change y el issue se cierra, ese trigger se registra como `thread-already-admitted` con el issue cerrado. La medición lo cuenta como parada perdida, porque no mira si el change sigue vivo.
- **El umbral lo agrava:** el análisis propone abrir la pieza de revocación con «al menos un caso». El primer change terminado lo cumpliría.
- **En `observe`:** no se crean vínculos entre hilo y change, así que la razón `thread-already-admitted` nunca aparece y la sección saldrá siempre vacía.

**Decisión pendiente:** avisarlo en el PR y rotular la sección como «candidatas», o añadir a cada fila el estado del change, lo que amplía el encargo.

### H2 · En una base de fase 1, `report` dice que el residente nunca se ejecutó (baja)

`hasAdmission` mira solo la tabla `adm_thread_changes`, que llegó un commit después de las primeras `adm_*`. En una base con decisiones guardadas pero sin esa tabla, el informe ahora responde «el residente nunca se ha ejecutado en esta base».

Solo afecta a bases de desarrollo creadas entre el 10 y el 11 de noviembre: no hubo ninguna versión publicada entre ambos commits.

**Arreglo:** en la rama `report`, comprobar cualquier tabla `adm_*`.

### H3 · Falta el test del orden habitual de una parada (baja)

Ningún test cubre una fila que no cumple seguida de otra del mismo hilo que sí: una actualización inocua con la etiqueta puesta y, después, la etiqueta retirada. Si el código mirase solo la primera fila de cada hilo, los 11 tests seguirían pasando.

**Arreglo:** añadir ese hilo al test de `stopsLost`.

### H4 · Una fila mal formada tumba el informe entero (baja)

Una decisión `thread-already-admitted` con una política sin `triggerLabel`, o con un evento sin `labels`, lanza `TypeError` y deja sin salida también las secciones que antes funcionaban. El residente nunca escribe filas así; haría falta una edición manual de la base.

**Arreglo:** dos expresiones tolerantes en `report.ts:46-47`.

### Menores

- **H5 · Caracteres de control en la salida de texto.** `url`, `author` y `thread` se imprimen sin filtrar. No es explotable hoy, porque los valores llegan de la API de GitHub, pero el código solo comprueba que sean cadenas.
- **H6 · `fab resident --mode off` crea el esquema.** Es anterior a este cambio y queda fuera de T13-b.
- **H7 · Dos lecturas engañosas que el encargo permite.** `followupsLost` incluye comentarios anteriores a la admisión del hilo. En `observe`, un hilo admitido al que se le retira la etiqueta aparece en `unlabeledTrusted`; se distingue porque `admittedAt` es anterior a `firstSeen`.

## 3. Mutaciones que sobreviven

De las cinco, solo la primera señala un hueco real.

| Mutación | Lectura |
|---|---|
| Mirar solo la primera fila `thread-already-admitted` por hilo | Hueco real: H3 |
| Comparar la etiqueta por subcadena | Hueco menor: ningún test tiene una etiqueta que contenga a otra |
| `reasons.includes` en vez de `reasons[0]` | Equivalente: esa razón solo se escribe en primera posición |
| `LEFT JOIN` en vez de `JOIN` | Equivalente con la clave foránea activa |
| Asociación pasada a mayúsculas | Equivalente con los valores de la API |

## 4. Contraste con el informe del implementador

Coincide en los archivos tocados, las definiciones, los tests que fallaban antes, el typecheck y el alcance. No menciona ninguno de los hallazgos H1 a H7.

## 5. Lo que no se revisó

- La suite completa. Solo se ejecutaron `tests/admission-report.test.ts` (11 pass) y `bun run typecheck`.
- Un ciclo real del residente contra GitHub, en `observe` o en `auto`.
- `--mode auto` sin `--self` (parte de H6).
- Si la API de GitHub puede devolver caracteres de control en `html_url` o `login`.
- El rendimiento del informe con muchas decisiones.
