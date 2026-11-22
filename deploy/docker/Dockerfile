# Dockerfile de referencia para fab modo servidor con mTLS (T118b, D-4 Opción A)
FROM oven/bun:1.3.14-slim AS base

WORKDIR /app

# Crear usuario y grupo de servicio no privilegiados
RUN groupadd -g 1000 fab && \
    useradd -u 1000 -g fab -m -s /bin/bash fab && \
    mkdir -p /var/lib/fab /etc/fab/certs && \
    chown -R fab:fab /app /var/lib/fab /etc/fab/certs

# Copia de dependencias y código fuente
COPY package.json tsconfig.json ./
COPY src/ ./src/
COPY deploy/ ./deploy/

RUN chown -R fab:fab /app

USER fab

ENV NODE_ENV=production
ENV FABRICA_HOME=/var/lib/fab

# El backend NO publica puertos en la red del host; escucha internamente para mTLS
EXPOSE 8443

CMD ["bun", "run", "src/cli.ts", "web", "--server", "--port", "8443", \
     "--public-origin", "${FAB_PUBLIC_ORIGIN}", \
     "--tls-cert", "/etc/fab/certs/server.crt", \
     "--tls-key", "/etc/fab/certs/server.key", \
     "--tls-ca", "/etc/fab/certs/ca.crt"]
