# DOC-303: VerificationContract (Misiones y Contratos Objetivos)

**Código:** DOC-303  
**Versión:** 1.0  
**Fase:** F1C — Entrada a Fábrica de Software  
**Emisor:** Solution Architect / Ingeniero del Lab  
**Receptor:** Runner de Misiones de `sw-factory` (`features.json`)  
**Archivo Relacionado:** [`DOC-303-VerificationContract.json`](DOC-303-VerificationContract.json)

---

## 1. Propósito y Modelo de Seguridad

En el desarrollo asistido por agentes de IA existe el riesgo de **falsos positivos** (donde el agente afirma en su texto que el trabajo está terminado o vacía los tests para que no fallen). 

El `VerificationContract` es el mecanismo técnico que garantiza la verdad del runtime:
1. **Runner Objetivo:** Los comandos de prueba no los ejecuta el modelo; los ejecuta el runner de la fábrica sobre una copia limpia y desechable.
2. **Sandbox Estricto:** La verificación corre obligatoriamente bajo `bwrap` con red desconectada (`--unshare-net`) y variables de entorno limpias.
3. **Inmutabilidad Sellada:** Una vez que el contrato es planificado, no puede ser modificado por ningún agente para rebajar exigencias.

---

## 2. Definición de Campos del Contrato

### `verificationCommands` (Comandos de Verificación)
- **Tipo:** Array de strings (comandos sin shell).
- **Comportamiento:** Comandos deterministas que se ejecutan secuencialmente. Si cualquiera de ellos arroja un código de salida distinto de `0`, la tarea queda inmediatamente en estado `paused` (`contract_failed`) y no se marca como completada.
- **Ejemplo:** `["bun test tests/unit/", "bunx tsc --noEmit"]`

### `protectedPaths` (Rutas Protegidas)
- **Tipo:** Array de rutas de archivo relativas a la raíz del repositorio.
- **Comportamiento:** El runner calcula el hash SHA-256 de estos archivos **antes de que el primer worker empiece a trabajar**. Si al finalizar el turno el hash de cualquiera de estos archivos ha cambiado, la ejecución se bloquea inmediatamente (`protected_paths_changed`).
- **Uso crítico:** Proteger los archivos de tests (`tests/**/*.test.ts`) y los fixtures de datos (`fixtures/*.json`) para impedir que el agente altere las aserciones de prueba.

---

## 3. Invocación desde el CLI de la Fábrica

Para correr un cambio bajo el modo de misiones con este contrato:

```bash
bun src/cli.ts exec \
  --cwd /ruta/al/worktree \
  --mission \
  --auto high \
  --worker-model "qwen3.5-32k:latest" \
  --validator-model "qwen3.5-32k:latest" \
  "Ejecutar milestone según features.json"
```

El runner reportará `contractSatisfied: true` únicamente si los tests pasaron de verdad y ningún archivo protegido fue alterado.
