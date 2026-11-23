# Guía de Despliegue y Operación: Modo Servidor (T118)

Esta guía documenta la arquitectura de despliegue, la configuración de red y la operación de recuperación para **fab en modo servidor** en una máquina virtual o servidor dedicado, según el diseño T118 (§1, §3.1, §3.2, §3.3) y la decisión D-4 (Opción A).

---

## 1. Arquitectura y Fronteras de Seguridad

### 1.1 Principio de diseño (D-4 Opción A)
- **Frontal público único:** Caddy es el único servicio expuesto a Internet en puertos 80 (redirección) y 443 (HTTPS canónico). Administra el certificado TLS público y emite la cabecera `Strict-Transport-Security: max-age=31536000; includeSubDomains` (HSTS).
- **Salto autenticado al backend:**
  - **Variante systemd (piloto operativo recomendado):** fab escucha exclusivamente en un socket Unix bajo `/run/fab/fab.sock`. El socket pertenece al usuario `fab` y al grupo de servicio `fab-web`, con permisos estrictos `0660`. Caddy pertenece a `fab-web`. Procesos ajenos al grupo, el sandbox de workers y servicios externos carecen de acceso de lectura o escritura al socket. No se abre ningún listener TCP en esta variante.
  - **Variante Docker:** fab y Caddy se comunican en una red interna Docker mediante mTLS estricto (`requestCert: true, rejectUnauthorized: true`). La CA interna dedicada emite certificados de cliente y servidor con vigencia inicial de 30 días y alerta a los 7 días de vencer. El puerto de backend (8443) **nunca** se publica en la red del host.
- **Validación canónica de Host y Origin:**
  - Si la cabecera `Host` no coincide exactamente con el host canónico configurado en `publicOrigin` (ej. `fab.ejemplo.com`), el backend responde inmediatamente `403 Forbidden`.
  - En peticiones `POST`, si la cabecera `Origin` está ausente o no coincide con `publicOrigin`, el backend responde `403 Forbidden`.
  - Caddy descarta cabeceras `X-Forwarded-*` provenientes del cliente para prevenir spoofing, y emite `X-Fab-Client-IP` con la IP real observada para el límite de tasas.

---

## 2. Despliegue con systemd (Piloto Operativo)

### 2.1 Preparación de la VM (Ubuntu 24.04 LTS)
```bash
# 1. Crear usuario y grupo de servicio dedicado
sudo groupadd -r fab-web
sudo useradd -r -s /usr/sbin/nologin -g fab-web -G fab-web -d /var/lib/fab -m fab

# 2. Agregar el usuario de Caddy al grupo fab-web
sudo usermod -aG fab-web caddy

# 3. Instalar Bun globalmente para el sistema
curl -fsSL https://bun.sh/install | bash
sudo mv ~/.bun/bin/bun /usr/local/bin/bun

# 4. Instalar código de la fábrica en /opt/fab
sudo git clone -b release/0.1.0-rc.12 https://github.com/fabrica/fabrica /opt/fab
sudo chown -R fab:fab-web /opt/fab
```

### 2.2 Configuración de systemd
Copiar la unidad de servicio:
```bash
sudo cp deploy/systemd/fab.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now fab.service
```
El servicio gestiona directamente el ciclo de vida del socket Unix en `/run/fab/fab.sock` mediante `RuntimeDirectory=fab`, `RuntimeDirectoryMode=0770` y `UMask=0007`, garantizando permisos `0660` sin requerir activación por socket externa.

**Identidad (T119e).** `fab web --server` no arranca sin la aplicación OAuth de GitHub ni sin el bootstrap del primer owner (§2):
- `FAB_GITHUB_CLIENT_ID` (en la unidad) y los ficheros `/etc/fab/github-client-secret` y `/etc/fab/service-secret` (0600, propiedad de root), que systemd entrega como credenciales. `service-secret` fija el secreto de CSRF; sin él cambia en cada arranque.
- El primer owner se crea por consola con emisor `github` y el ID numérico de su cuenta (`bootstrapOwner`). **Aún no hay comando `fab user bootstrap`** (pendiente).
- Caddy debe emitir `X-Fab-Client-IP` y descartar `X-Forwarded-*`: de ahí salen los límites de login y pareo.

Verificar estado y permisos del socket:
```bash
sudo systemctl status fab.service
ls -la /run/fab/fab.sock
# Salida esperada: srw-rw---- 1 fab fab-web 0 /run/fab/fab.sock (permisos 0660)
```

### 2.3 Configuración de Caddy
Copiar `deploy/caddy/Caddyfile` a `/etc/caddy/Caddyfile`, sustituyendo `fab.ejemplo.com` por el dominio canónico asignado.
```bash
sudo systemctl reload caddy
```

---

## 3. Despliegue en Contenedores (Docker + mTLS)

Si se opta por contenedores:
1. Generar la infraestructura mTLS con usos separados (serverAuth vs clientAuth) y CA cliente dedicada (vigencia inicial de 30 días):
   ```bash
   # Generar en ./certs
   # CA dedicada para clientes (Caddy)
   openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/client-ca.key -out certs/client-ca.crt -days 30 -subj "/CN=FabClientCA"
   # CA dedicada para servidores backend
   openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/server-ca.key -out certs/server-ca.crt -days 30 -subj "/CN=FabServerCA"

   # Certificado de backend con serverAuth
   openssl req -newkey rsa:2048 -nodes -keyout certs/server.key -out certs/server.csr -subj "/CN=fab-backend"
   openssl x509 -req -in certs/server.csr -CA certs/server-ca.crt -CAkey certs/server-ca.key -CAcreateserial -out certs/server.crt -days 30 -extfile <(printf "extendedKeyUsage = serverAuth\nsubjectAltName = DNS:fab-backend")

   # Certificado de cliente Caddy con clientAuth
   openssl req -newkey rsa:2048 -nodes -keyout certs/client.key -out certs/client.csr -subj "/CN=caddy"
   openssl x509 -req -in certs/client.csr -CA certs/client-ca.crt -CAkey certs/client-ca.key -CAcreateserial -out certs/client.crt -days 30 -extfile <(printf "extendedKeyUsage = clientAuth")
   ```
2. Iniciar con Docker Compose:
   ```bash
   cd deploy/docker
   docker compose up -d
   ```
> [!NOTE]
> **Enlace de interfaces en Docker (T118-H13):** En la variante Docker, el backend enlaza el puerto interno 8443 en la interfaz del contenedor para escuchar peticiones mTLS. Dicho puerto no se publica en la red del host (`expose: 8443` en `docker-compose.yml`), siendo accesible únicamente a través de la red interna privada `fab-internal` por Caddy.

> [!IMPORTANT]
> **Aislamiento de claves mTLS y CA de cliente única (T118-P2-1):** En Docker Compose no se monta el directorio `./certs` al completo. Cada contenedor recibe únicamente los certificados y claves indispensables para su rol. Las claves privadas de las CA (`client-ca.key`, `server-ca.key`) permanecen fuera de los contenedores en el host. Asimismo, `client-ca.crt` debe firmar exclusiva y unívocamente el certificado de Caddy (`CN=caddy`), evitando emitir certificados adicionales bajo esa CA para garantizar que ningún otro proceso o worker acceda al backend.

> [!IMPORTANT]
> **Restricción de SQLite en Docker (D2N-H14):** La variante web en contenedor más pool en host compartirá SQLite únicamente mediante montaje de disco local bajo el mismo kernel, host coordinador y UID escritor. Quedan excluidos volúmenes remotos (NFS, SMB), escritores en otra VM, contenedores privilegiados y sockets Docker expuestos. Si el entorno no cumple estas condiciones, use systemd.

---

## 4. Procedimiento de Copia de Seguridad y Restauración (§3.2, §3.3)

### 4.1 Objetivos de recuperación
- **RPO (Punto Objetivo de Recuperación):** 24 horas (respaldos diarios con diario de transacciones).
- **RTO (Tiempo Objetivo de Recuperación):** 2 horas. En el simulacro de recuperación se verifica un tiempo real de ejecución inferior a 1 segundo.

### 4.2 Ejecución de copia de seguridad
El script `deploy/scripts/backup.sh` realiza un checkpoint pasivo del WAL de SQLite (`PRAGMA wal_checkpoint(PASSIVE)`) y crea una copia consistente mediante `VACUUM INTO`, calculando el digest SHA256:
```bash
sudo -u fab /opt/fab/deploy/scripts/backup.sh /var/lib/fab/fabrica.db /var/backups/fab
```
> [!NOTE]
> **Alcance T118 vs T120 (§3.2):** T118b entrega la copia local atómica en WAL, integridad SHA256 y simulacro automatizado de restauración. El cifrado en reposo de las copias, la replicación continua fuera de la VM y las políticas de retención histórica corresponden a la tarea T120.

### 4.3 Restauración y reapertura básica (§3.3)
1. Detener el servicio fab:
   ```bash
   sudo systemctl stop fab.service
   ```
2. Ejecutar la restauración hacia un nuevo directorio limpio (o con `--force` si se reemplaza el existente):
   ```bash
   sudo -u fab /opt/fab/deploy/scripts/restore.sh /var/backups/fab/fabrica-backup-20261122T000000Z.db /var/lib/fab-restored
   ```
   El script verifica obligatoriamente el checksum SHA256 (salvo `--no-checksum`), copia a un archivo temporal para verificar `PRAGMA integrity_check` y `PRAGMA foreign_key_check`, audita recuentos y renombra atómicamente a `fabrica.db` solo tras superar todas las comprobaciones.
3. Iniciar el servicio con el nuevo estado:
   ```bash
   sudo systemctl start fab.service
   ```

### 4.4 Simulacro automatizado de recuperación
Para validar el circuito completo en cualquier entorno de pruebas:
```bash
bun run deploy/scripts/simulacro-recuperacion.ts
```
