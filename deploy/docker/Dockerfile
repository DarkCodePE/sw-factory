# Dockerfile de referencia para fab modo servidor con mTLS (T118b, D-4 Opción A)
FROM oven/bun:1.3.14-slim AS base

WORKDIR /app

# Usar el usuario bun no privilegiado existente (UID 1000, GID 1000)
RUN mkdir -p /var/lib/fab /etc/fab/certs && \
    chown -R bun:bun /app /var/lib/fab /etc/fab/certs

# Copia de dependencias e instalación
COPY package.json tsconfig.json ./
RUN bun install --production

# Copia de código fuente
COPY src/ ./src/
COPY deploy/ ./deploy/

RUN chown -R bun:bun /app

USER bun

ENV NODE_ENV=production
ENV FABRICA_HOME=/var/lib/fab

# El backend NO publica puertos en la red del host; escucha internamente para mTLS
EXPOSE 8443

# CLI lee FAB_PUBLIC_ORIGIN del entorno sin necesidad de expansión en CMD exec
CMD ["bun", "run", "src/cli.ts", "web", "--server", "--port", "8443", \
     "--tls-cert", "/etc/fab/certs/server.crt", \
     "--tls-key", "/etc/fab/certs/server.key", \
     "--tls-ca", "/etc/fab/certs/client-ca.crt"]
