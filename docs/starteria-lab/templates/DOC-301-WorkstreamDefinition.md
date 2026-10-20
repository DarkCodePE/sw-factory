# DOC-301: WorkstreamDefinition

**Código:** DOC-301  
**Versión:** 1.0  
**Fase:** F1C — Entrada a Fábrica de Software  
**Emisor:** Ingeniero del Lab  
**Receptor:** CLI `fab` / SQLite `fabrica.db`  
**Iniciativa:** `[Nombre de la iniciativa]`

---

## 1. Parámetros de Creación del Workstream

Para registrar el proyecto en la fábrica de software (`sw-factory`), el Ingeniero del Lab ejecuta el comando `fab ws create` con los siguientes parámetros:

```bash
fab ws create <slug> \
  --repo <ruta_absoluta_repositorio> \
  --goal "<objetivo_tecnico_del_workstream>" \
  --agent <native|claude|codex|agy> \
  --concurrency 1 \
  --task-limit 10
```

### Tabla de Parámetros de Configuración

| Parámetro | Valor para este Proyecto | Descripción y Racional |
| :--- | :--- | :--- |
| **`slug`** | `[ej. conciliacion-xyz]` | Identificador único en minúsculas y sin espacios. |
| **`--repo`** | `/home/orlando/Desktop/factory/repos/[slug]` | Ruta absoluta al repositorio Git inicializado (`DOC-202`). |
| **`--goal`** | `"[Meta técnica general]"` | Propósito global que los agentes consultarán en cada prompt. |
| **`--agent`** | `[native \| claude \| codex \| agy]` | Agente de código a utilizar (por defecto `native` o `claude`). |
| **`--concurrency`** | `1` (recomendado para pilotos) | Número de workers concurrentes ejecutando cambios en paralelo. |
| **`--task-limit`** | `10` | Límite máximo de actividades antes de pausar el workstream. |

---

## 2. Configuración de Gates Humanos Obligatorios

Por defecto, la fábrica aplica las compuertas de seguridad para garantizar que ningún agente actúe sin supervisión:

```bash
# Activar el workstream tras crearlo
fab ws state <slug> active
```

- **`require_change_approval: 1 (true)`**: Un humano debe aprobar el cambio en el inbox antes de iniciar la investigación. *(No usar `--no-change-approval` en proyectos de clientes).*
- **`require_approval: 1 (true)`**: Un humano debe revisar y aprobar el `spec.md` producido por la investigación antes de autorizar la escritura de código en la rama `fab/<id>`. *(No usar `--no-spec-approval` en proyectos de clientes).*

---

## 3. Comandos de Operación y Monitoreo

### Iniciar el Pool de Workers
En una terminal dedicada (o proceso supervisor):
```bash
fab run <slug>
```

### Abrir el Panel Interactivo (TUI)
En otra terminal para supervisar en tiempo real, revisar specs y aprobar/rechazar:
```bash
fab tui <slug>
# Atajos: [↑↓] Moverse · [Enter] Ver detalle/spec · [a] Aprobar · [c] Comentar · [d] Rechazar · [q] Salir
```

### Verificación de Estado por CLI
```bash
fab status <slug>      # Resumen de changes, pendientes, en progreso e implementados
fab inbox <slug>       # Listado de actividades esperando aprobación humana
fab events <slug>      # Registro de auditoría de eventos ocurridos
```
