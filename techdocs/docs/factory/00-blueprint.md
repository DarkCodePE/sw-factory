# 00 · Blueprint

La factory es un **orquestador local de agentes de código**. No edita código: entrega *una activity a una corrida de agente* (`src/agents.ts:1-2`). Su trabajo es todo lo que rodea al agente: un estado transaccional en SQLite, un worktree Git por change, puertas humanas y automáticas, evidencia y fusión.

## 1. Diagrama de contexto

```mermaid
flowchart LR
    OP(["Operador<br/>fab CLI / fab tui"])
    subgraph FAB["Proceso fab (Bun)"]
        CORE["Factory<br/>store + pool + gates + validadores"]
    end
    REPOS[("Repos Git locales<br/>worktrees fab/id")]
    DB[("FABRICA_HOME<br/>fabrica.db, runs/, profiles/")]
    subgraph AG["Agentes externos (subprocesos headless)"]
        CL["claude"]
        CX["codex"]
        AGY["agy"]
        DR["droid"]
        NAT["native = fab exec<br/>(otra sección)"]
    end
    LLM{{"Proveedores LLM<br/>los llaman los agentes, no la factory"}}
    JIRA["Jira Cloud"]
    GH["GitHub (gh, git push)"]
    NPM["npm / GitHub Releases<br/>fab update"]

    OP --> CORE
    CORE <--> DB
    CORE <--> REPOS
    CORE -->|"Bun.spawn argv"| AG
    AG --> LLM
    AG -->|"edita archivos del worktree"| REPOS
    CORE <-->|"conectores"| JIRA
    CORE -->|"conectores"| GH
    CORE -.->|"fab update"| NPM
```

- La factory **nunca** habla con un proveedor LLM: lanza CLIs (`claude`, `codex`, `agy`, `droid`) o el propio `fab exec` como subprocesos (`src/agents.ts:39-142`). Los proveedores LLM del agente nativo se documentan en [fab exec](../exec/index.md).
- El estado vive en `FABRICA_HOME` (por defecto `~/.fabrica`): `fabrica.db`, `worktrees/`, `runs/`, `profiles/`, `agents.json`, `deps/` (`src/cli.ts:34`, `src/worktrees.ts:41`, `src/manifest.ts:36-38`, `src/profile.ts:70`, `src/agents-verify.ts:12-15`, `src/pool.ts:144`).

## 2. Diagrama de componentes por capa

```mermaid
flowchart TB
    subgraph L1["Capa 1 · Superficies"]
        CLI["cli.ts"]
        TUI["tui.ts"]
        SDK["sdk/"]
        CCLI["connectors/cli.ts, validators/cli.ts,<br/>profile-cli.ts, improve-cli.ts, agents-verify.ts"]
    end
    subgraph L2["Capa 2 · Dominio y estado"]
        ENUMS["enums.ts"]
        STORE["store.ts (Store)"]
        PROF["profile.ts"]
        LINKS["connectors/links.ts"]
    end
    subgraph L3["Capa 3 · Orquestación"]
        POOL["pool.ts (runPool, processActivity)"]
        PROMPTS["prompts.ts, validators/prompts.ts"]
        IMPROVE["improve.ts"]
    end
    subgraph L4["Capa 4 · Ejecución y confinamiento"]
        AGENTS["agents.ts, agents-verify.ts, self.ts"]
        GATES["gates.ts"]
        WT["worktrees.ts"]
        SBX["sandbox/"]
        TM["threatmon/"]
        INTEG["validators/integrity.ts"]
    end
    subgraph L5["Capa 5 · Evidencia y salida"]
        MAN["manifest.ts, manifest-capture.ts"]
        PUB["validators/publish.ts (merge)"]
        GHJ["connectors/github.ts, jira.ts, intake.ts"]
    end
    L1 --> L2
    L1 --> L3
    L3 --> L2
    L3 --> L4
    L3 --> L5
    L2 --> L5
    GATES --> SBX
    IMPROVE --> POOL
```

El detalle de dependencias reales está en [01 Capas](01-capas.md).

## 3. Flujo de extremo a extremo: de la señal al merge

Cadena de dominio: **workstream → signal → change → activity** (`src/enums.ts:1-2`). Un change avanza por activities (`change_review`, `investigation`, `implementation`, `gates`, validadores y `steward`), cada una ejecutada por un worker.

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operador
    participant CLI as cli.ts
    participant S as Store
    participant P as Pool (runPool)
    participant W as worktrees.ts
    participant A as Agente headless
    participant G as Gates (bwrap)
    participant M as mergeRecoverably

    Op->>CLI: fab signal add / fab triage
    CLI->>S: addSignal, triageSignal, createChange
    Note over S: change in_review + change_review awaiting<br/>(si requireChangeApproval)
    Op->>CLI: fab review approve
    CLI->>S: resolveReview, investigation pending
    Op->>CLI: fab run slug
    CLI->>P: runPool
    P->>S: claimActivity (lease)
    P->>W: ensureWorktree (rama fab/id, baseSha)
    P->>A: runAgent investigation (readOnly)
    A-->>P: informe STATUS done
    P->>S: completeActivity, change in_review (spec awaiting)
    Op->>CLI: fab review approve
    CLI->>S: implementation pending
    P->>A: runAgent implementation
    P->>P: threatmon, protectedIntegrity, commitWorktree
    P->>S: completeActivity, change implemented (+ gates pending si hay verify)
    P->>G: runGates (sandbox sin red)
    G-->>P: VERDICT pass + verifiedHead
    P->>S: completeActivity gates, enqueueValidators
    P->>A: validadores code_review, security_audit, qa
    A-->>P: VERDICT pass, fail o needs_human
    Op->>CLI: fab merge change
    CLI->>M: mergeRecoverably
    M->>M: mergeBlocker, git merge, removeWorktree
    M->>S: closeChange completed
```

Referencias por paso:

| Paso | Código |
|---|---|
| Alta de señal y triage | `Store.addSignal` `src/store.ts:428`, `triageSignal` `:449`, `createChange` `:476` |
| Primera activity según gate de change | `src/store.ts:490-501` |
| Decisión humana | `Store.resolveReview` `src/store.ts:944`, tabla `REVIEW_FOLLOW_UP` `src/enums.ts:73-76` |
| Claim con lease | `Store.claimActivity` `src/store.ts:628` |
| Worktree y base | `ensureWorktree` `src/worktrees.ts:37`, `setChangeBase` `src/store.ts:527` |
| Ciclo del worker | `processActivity` `src/pool.ts:95-351` |
| Gates tras implementar | `src/store.ts:859`, rama `gates` en `src/pool.ts:134-184` |
| Validadores tras gates | `enqueueValidators` `src/store.ts:726`, invocado en `:828` |
| Puerta de merge | `mergeBlocker` `src/validators/publish.ts:29`, `mergeRecoverably` `:70` |

Sin `--verify` no hay activity `gates`: los validadores se piden a mano con `fab validate` (`src/store.ts:723`, `src/validators/cli.ts:113`).

## 4. Principios de diseño que se repiten en el código

1. **Compare-and-set en SQLite.** Toda transición es un `UPDATE ... WHERE status = ...` dentro de una transacción `IMMEDIATE` (`src/store.ts:1-3`, `:281-301`). Ver [02](02-modelo-de-datos.md).
2. **El agente es una caja negra con contrato de texto.** La primera línea del informe debe ser `STATUS: done` o `STATUS: blocked - <motivo>`; los validadores añaden `VERDICT:` (`src/prompts.ts:25-28`, `src/validators/prompts.ts:5-12`).
3. **La factory verifica, no confía.** Integridad de rutas protegidas, threatmon sobre la salida y el diff, gates deterministas en sandbox ([07](07-seguridad.md), [06](06-gates-y-validadores.md)).
4. **Un solo escritor por change.** `claimActivity` excluye activities concurrentes del mismo change (`src/store.ts:640-644`).
5. **Evidencia redactada antes de tocar disco** (`src/manifest.ts:23-30`).

## Límites conocidos (visión general)

- La factory asume pools en la misma máquina (`src/store.ts:1073`: `shortcut: asume pools en la misma máquina`).
- El aislamiento de los agentes depende del adaptador; solo `native` y los gates usan el sandbox propio de fab ([07](07-seguridad.md)).
- La documentación de usuario (`README.md`) afirma que la implementación corre "confinada en sandbox"; en el código el confinamiento por adaptador es el que declara `isolationFor` (`src/manifest.ts:52-59`).

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `src/cli.ts` | Punto de entrada `fab`; enruta subcomandos. |
| `src/store.ts` | Estado transaccional y transiciones. |
| `src/pool.ts` | Workers y ciclo de una activity. |
| `src/worktrees.ts` | Worktree y rama por change. |
| `src/agents.ts` | Adaptadores de agentes headless. |
| `src/gates.ts` | Pasos de verificación declarados por el workstream. |
| `src/validators/` | Validadores, veredictos, integridad, merge. |
| `src/manifest.ts` | Evidencia por change. |
