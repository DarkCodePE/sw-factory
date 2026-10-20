# Instalación y actualización por canales

El bootstrap utiliza el mismo esquema de canales que Whip: `stable` por defecto,
selección opcional de prereleases y versión fija para reproducir una instalación.
La detección de sistema y arquitectura mantiene Linux glibc y macOS, x64/ARM64.
Windows nativo y musl no están incluidos; WSL utiliza Linux.

## Instalar sin escribir una versión

```sh
# Última estable completa:
curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/scripts/install.sh | sh

# Mientras FAB esté en RC, o para participar en ese canal:
curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/scripts/install.sh |
  sh -s -- --channel prerelease

# Versión exacta, opcional:
curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/scripts/install.sh |
  sh -s -- --version v0.1.0-rc.6
```

El bootstrap requiere `curl`, Python 3.8+ y `sha256sum` o `shasum`. No requiere Bun,
sudo ni modificaciones del perfil del shell. Instala en `~/.local/bin` y permite
elegir otro directorio absoluto con `--install-dir` o `FAB_INSTALL_DIR`.

Si no existe una estable completa, el canal estable informa cómo optar por
`prerelease`; no cambia de canal silenciosamente. `prerelease` considera tanto
candidatas como finales, eligiendo la mayor SemVer disponible. Una final puede
reemplazar a sus RC sin mantener al usuario en una candidata anterior.

Las variables `FAB_CHANNEL` y `FAB_VERSION` configuran el bootstrap fuente.
Sus opciones CLI tienen prioridad; un pin explícito permite rollback.

## Instaladores de cada release

El empaquetado genera y sella tres scripts; los bytes publicados son inmutables:

| Archivo | Política |
| --- | --- |
| `install.sh` | Fijado a la versión de esa release, también para una RC; no necesita argumentos. |
| `latest.sh` | Siempre busca la última estable completa. |
| `prerelease.sh` | Siempre busca la última versión del canal prerelease. |

Esas políticas ignoran las variables de selección del bootstrap y rechazan
opciones CLI incompatibles. `--install-dir` y `--check` siguen disponibles.
Una vez exista una release estable, su `latest.sh` se obtiene también mediante
`https://github.com/DarkCodePE/sw-factory/releases/latest/download/latest.sh`.

GitHub `latest` excluye prereleases. En npm, `latest` corresponde al canal estable
y `next` al de candidatas. La primera publicación de FAB dejó un RC en npm
`latest`; el actualizador lo rechaza como estable hasta publicar una final.

## Actualizar la instalación existente

```sh
fab update
fab update --check
fab update --channel stable
fab update --channel prerelease
fab update --version v0.1.0-rc.6
```

Sin selección explícita, una versión instalada RC sigue `prerelease` y una final
sigue `stable`. `--channel` tiene prioridad sobre `FAB_CHANNEL`. Después de
graduar a una final, la inferencia predeterminada pasa a estable, como en Whip.
`--check` consulta y compara sin instalar. Las actualizaciones automáticas no
retroceden de versión; `--version` permite solicitar un rollback explícito.

El binario independiente utiliza el instalador propio embebido, comprueba
SHA-256 y la versión descargada y reemplaza `fab` atómicamente en su mismo
directorio. Una ejecución desde fuentes no reemplaza el intérprete Bun.

El launcher npm identifica el paquete global que lo lanzó. La actualización
valida nombre, versión, ruta y hash del ejecutable en caché, descarga el tarball
público con SHA-512 y delega en npm usando ese mismo prefix. No modifica el binario
de caché para simular un cambio de paquete. Instalaciones locales, enlaces de
desarrollo u otros gestores deben actualizarse mediante su gestor correspondiente.
La operación de npm no es un reemplazo atómico del paquete completo; si npm falla,
puede requerir reparación con npm. Las descargas inválidas se rechazan antes de
invocarlo y la caché anterior permanece intacta.

La actualización tiene un límite total de cinco minutos. Cancelación y timeout
terminan el grupo propio de procesos, con hasta 200 ms de gracia antes de SIGKILL.
Los procesos reciben únicamente PATH, HOME y TMPDIR; npm utiliza configuraciones
temporales vacías y no recibe tokens heredados.

## Verificación

`tests/installer.test.ts` cubre canales, políticas generadas, SemVer, paginación
completa, ausencia de estable, flags/inventarios inválidos, checksums, versión del
binario, destinos y downgrade. `tests/update.test.ts` cubre ownership npm,
tarballs, credenciales, consulta sin efectos, rollback, timeout de red y eliminación
de descendientes. El smoke de distribución exige ayuda del actualizador compilado;
cada host nativo ejecuta además `scripts/release/probe-update.mjs`: copia el binario
compilado a un destino temporal con espacios, rechaza bytes corruptos conservando
el original, consulta sin modificarlo y ejecuta un reemplazo real con una release
sintética offline. El sello exige esos resultados en las cuatro plataformas.

La referencia de comportamiento es Whip, commit
`1c5da05987d2869687dfc95fc9128ad2ad68e0f0`: `install.sh` e
`internal/update/releases.go`. FAB implementa su propio instalador y actualizador.

## YOLO (desde 0.1.0-rc.9)

Actualiza el canal actual sin indicar versión con `fab update`. Luego:

```sh
fab --yolo
fab tui --yolo
fab exec --yolo "Implementa y verifica la tarea"
```

La activación es por invocación: comandos en el host, con su red y sin
aprobaciones de FAB. No se guarda en preferencias ni al reanudar una sesión.
`/yolo` muestra el estado; para volver al modo normal, inicia FAB sin el flag.
Si configuraste red `ask` o `deny`, el arranque exige una decisión explícita:
`fab --yolo --sandbox-network auto`. No combines YOLO con `--sandbox`,
`--use-spec` ni `--auto off|low|medium`. AskUser sigue preguntando por información.
