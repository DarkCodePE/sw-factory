# Sandbox para Workers de la Fábrica de Software (`sw-factory`)

Módulo de contención y aislamiento para comandos ejecutados por los agentes de la fábrica de software.

---

## 1. Diseño y Modelo de Seguridad

Este módulo proporciona aislamiento de procesos apoyándose en `bubblewrap` (`bwrap`), siguiendo los principios de contención analizados en el informe de referencia (`doc/droid-re/reports/07-sandbox-nativo-apply-seccomp.md`):

1. **User Namespaces (`userns`)**: Creación de namespaces de usuario sin privilegios para aislar las identidades UID/GID.
2. **Mount Namespaces (`CLONE_NEWNS`)**:
   - **Raíz del sistema en solo lectura (`--ro-bind / /`)**: Ningún worker puede alterar binarios del sistema, configuraciones globales ni librerías del host.
   - **Workdir escribible (`--bind <workdir> <workdir>`)**: El directorio del worktree del change actual es el único espacio del proyecto con permisos de escritura.
   - **`/tmp` privado (`--tmpfs /tmp`)**: Cada ejecución cuenta con un sistema de archivos temporal en memoria volátil e invisible para otros procesos.
   - **`/dev` y `/proc` propios (`--dev /dev`, `--proc /proc`)**: Montajes independientes que evitan la visibilidad de procesos ajenos en el host.
3. **PID, IPC y UTS Namespaces**:
   - `--unshare-pid`: El proceso del worker se convierte en el PID 1 de su árbol y no ve procesos del sistema.
   - `--unshare-ipc`: Bloquea memoria compartida y semáforos SysV/POSIX del host.
   - `--unshare-uts`: Aísla el hostname y dominio del contenedor.
   - `--die-with-parent`: Garantiza que los procesos hijos mueran si el proceso padre termina.
   - `--new-session`: Evita secuestro de terminal TTY.
4. **Aislamiento de Red (`--unshare-net`)**:
   - Por defecto, el worker no tiene acceso a interfaces de red externas (loopback vacío e inactivo).
   - Opcionalmente configurable mediante `allowNetwork: true` para operaciones que requieran acceso a internet (ej. descarga de dependencias o clonado de repositorios).
5. **Aislamiento de Variables de Entorno (`--clearenv`)**:
   - Se limpia el entorno del proceso padre.
   - Se inyecta un entorno explícito controlado con `PATH`, `HOME=<workdir>` y las variables estrictamente necesarias provistas por el caller.

---

## 2. Diagnóstico Crítico: AppArmor en Ubuntu 24.04+ (Noble Numbat)

En Ubuntu 24.04 y kernels modernos de Ubuntu/Debian, la directiva del kernel:
```bash
kernel.apparmor_restrict_unprivileged_userns = 1
```
está activada por defecto. Esta política impide que binarios sin un perfil específico de AppArmor creen *unprivileged user namespaces*, resultando en el siguiente error al ejecutar `bwrap 0.9.0`:

```text
bwrap: setting up uid map: Permission denied
```

### Principio de Verificación Real (No Asumir)
`detectSandbox()` no se limita a comprobar la presencia de `/usr/bin/bwrap`. En su lugar, **ejecuta una prueba real** (`bwrap --ro-bind / / true`) y captura la salida para comprobar si el kernel permite la operación. Si falla:
- **`mode: 'best-effort'` (predeterminado):** Devuelve el comando original sin envolver, marcando `backend: 'none'`, `degraded: true` y la razón diagnóstica. **Nunca finge aislamiento.**
- **`mode: 'required'`:** Lanza un error `SandboxUnavailableError` con las instrucciones exactas de remediación.

---

## 3. Remediación Exacta para Administradores de Sistema

> **NOTA:** Esta remediación **NO** se aplica automáticamente por el software; requiere privilegios de `sudo`/`root` en la máquina anfitriona.

### Opción 1: Instalar Perfil de AppArmor para `bwrap` (Recomendada)

Permite la creación de user namespaces exclusivamente al binario `/usr/bin/bwrap`, manteniendo la protección de AppArmor activa para el resto del sistema.

1. Crear el archivo de perfil `/etc/apparmor.d/bwrap-userns-restrict`:
```bash
sudo tee /etc/apparmor.d/bwrap-userns-restrict << 'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Extensiones o anulaciones locales si existen
  include if exists <local/bwrap>
}
EOF
```

2. Cargar el perfil en el kernel:
```bash
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

3. Verificar que `bwrap` ahora funciona sin privilegios:
```bash
bwrap --ro-bind / / true && echo "¡Sandbox operativo!"
```

---

### Opción 2: Desactivar la Restricción vía `sysctl` (Alternativa Global)

Desactiva la restricción de user namespaces a nivel de todo el sistema operativo.

- **Aplicación temporal (activa hasta el próximo reinicio):**
  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

- **Aplicación persistente:**
  ```bash
  echo "kernel.apparmor_restrict_unprivileged_userns = 0" | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf
  sudo sysctl -p /etc/sysctl.d/60-apparmor-namespace.conf
  ```

---

## 4. API de TypeScript

El módulo exporta las siguientes interfaces y funciones desde `src/sandbox/index.ts`:

### `detectSandbox(forceRefresh?: boolean)`
Detecta la disponibilidad y capacidades del sandbox. Ejecuta una prueba real y cachea el resultado.

```typescript
import { detectSandbox } from './sandbox/index.ts';

const status = await detectSandbox();
console.log(status);
// {
//   backend: 'bwrap' | 'none',
//   available: boolean,
//   reason: string,
//   network: boolean
// }
```

### `wrapCommand(argv, opts)`
Envuelve un comando de ejecución según las opciones proporcionadas.

```typescript
import { wrapCommand } from './sandbox/index.ts';

const wrapped = await wrapCommand(['pytest', '-q'], {
  workdir: '/path/to/worktrees/slot-1',
  allowNetwork: false,              // Aislamiento total de red (--unshare-net)
  readOnlyPaths: ['/opt/shared'],   // Montajes adicionales de solo lectura
  writablePaths: ['/tmp/cache'],    // Montajes adicionales escribibles
  env: { PYTHONDONTWRITEBYTECODE: '1' },
  mode: 'best-effort',              // 'best-effort' (default) o 'required'
});

console.log(wrapped);
// Si bwrap está disponible:
// {
//   argv: ['bwrap', '--ro-bind', '/', '/', ..., '--', 'pytest', '-q'],
//   env: { PATH: '...', HOME: '/path/to/worktrees/slot-1', PYTHONDONTWRITEBYTECODE: '1' },
//   backend: 'bwrap',
//   degraded: false,
//   reason: 'bubblewrap sandbox active'
// }
// Si bwrap no está disponible en modo 'best-effort':
// {
//   argv: ['pytest', '-q'],
//   env: { PYTHONDONTWRITEBYTECODE: '1' },
//   backend: 'none',
//   degraded: true,
//   reason: 'bwrap failed: setting up uid map: Permission denied...'
// }
```

### `sandboxReport(forceRefresh?: boolean)`
Genera un informe diagnóstico textual con el estado actual y los pasos de remediación.

```typescript
import { sandboxReport } from './sandbox/index.ts';

console.log(await sandboxReport());
```

---

## 5. Ejemplo de Ejecución con `Bun.spawn`

```typescript
import { wrapCommand } from './src/sandbox/index.ts';

async function executeInSandbox(cmd: string[], workdir: string) {
  const sandboxed = await wrapCommand(cmd, {
    workdir,
    allowNetwork: false,
    mode: 'best-effort',
  });

  if (sandboxed.degraded) {
    console.warn(`[WARN] Ejecutando sin sandbox (degradado): ${sandboxed.reason}`);
  }

  const proc = Bun.spawn(sandboxed.argv, {
    cwd: workdir,
    env: sandboxed.env,
  });

  const exitCode = await proc.exited;
  return exitCode;
}
```
