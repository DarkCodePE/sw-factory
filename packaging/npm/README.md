# FAB

Agente y fábrica de software con runtime propio. Node instala y lanza el binario de la misma release; no hace falta instalar Bun.

```sh
npm install -g @okuanb/fab@next
fab --version
fab tui
```

El paquete contiene el manifest de la release con el SHA de origen y el checksum exacto de cada binario. Verifica los bytes antes de ejecutarlos, incluso si se instalaron con `--ignore-scripts`. Descarga exclusivamente desde GitHub mediante HTTPS. Binarios en `~/.cache/fab/<version>/<sha256>/`.

Linux glibc y macOS: x64/arm64. Windows: WSL. El sandbox de herramientas requiere bubblewrap en Linux; macOS no tiene sandbox equivalente implementado. Git y la configuración del proveedor se preparan por separado.

Código y documentación: https://github.com/DarkCodePE/sw-factory
