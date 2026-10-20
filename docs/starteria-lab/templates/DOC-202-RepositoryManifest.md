# DOC-202: RepositoryManifest & Scaffolding

**Código:** DOC-202  
**Versión:** 1.0  
**Fase:** F1C — Preparación Técnica del Lab  
**Emisor:** Tech Lead / Ingeniero del Lab  
**Receptor:** `sw-factory` (Sistema de archivos local)  
**Iniciativa:** `[Nombre de la iniciativa]`

---

## 1. Identificación y Localización del Repositorio

- **Nombre del Repositorio:** `[nombre-proyecto-lab]`
- **Ruta Absoluta Local:** `/home/orlando/Desktop/factory/repos/[nombre-proyecto-lab]`
- **Rama Base Inicial:** `main` (commit inicial de scaffolding)
- **Gestor de Control de Versiones:** `git` (verificado con `git status`)

---

## 2. Stack Tecnológico y Requisitos de Runtime

- **Lenguaje Principal:** `[Ej. TypeScript 5.6 / Python 3.12 / Go 1.23]`
- **Runtime / Motor de Ejecución:** `[Ej. Bun ≥ 1.3 / Node.js 22 LTS / CPython]`
- **Framework Web / Backend:** `[Ej. Next.js 15 / FastAPI / Express / Hono]`
- **Motor de Base de Datos:** `[Ej. SQLite (better-sqlite3 o bun:sqlite) / PostgreSQL]`
- **Gestor de Paquetes:** `[Ej. bun install / npm install / poetry]`

---

## 3. Estructura de Directorios Base

El repositorio base debe estar inicializado respetando la siguiente estructura de carpetas estándar:

```text
/
├── src/
│   ├── index.ts               # Punto de entrada de la aplicación / API
│   ├── routes/                # Controladores y endpoints
│   ├── services/              # Lógica de negocio
│   └── models/                # Definición de tipos y esquemas
├── tests/
│   ├── unit/                  # Tests unitarios rápidos
│   └── integration/           # Tests de integración con base de datos/mocks
├── fixtures/                  # Datos sintéticos y muestras de prueba (DOC-203)
├── .env.example               # Variables de entorno requeridas sin valores secretos
├── package.json               # Dependencias y scripts
├── tsconfig.json              # Configuración estricta de compilador
└── README.md                  # Instrucciones para humanos y agentes
```

---

## 4. Harness de Pruebas y Scripts Obligatorios

Para que la fábrica de software (`sw-factory`) pueda evaluar objetivamente el código, el repositorio **debe** responder a los siguientes comandos desde la raíz:

1. **Comando de Test Automatizado:**
   - Comando: `bun test` (o `npm test` / `pytest`)
   - Requisito de entrada: Debe existir al menos un test de prueba (`tests/smoke.test.ts`) que pase exitosamente (`exitCode: 0`).
2. **Comando de Verificación de Tipos / Linter:**
   - Comando: `bunx tsc --noEmit` (o `npm run lint`)
   - Requisito de entrada: Compilación limpia sin errores iniciales.
3. **Comando de Ejecución Local:**
   - Comando: `bun run dev` (o `bun start`)

---

## 5. Checklist de Verificación Pre-Fábrica

El Ingeniero del Lab debe marcar todos los ítems antes de crear el workstream en la fábrica:

- `[ ]` `git status` limpio en rama `main` tras el commit de scaffolding inicial.
- `[ ]` Archivo `.gitignore` configurado (ignora `node_modules/`, `.env`, builds).
- `[ ]` No existen credenciales, tokens ni API keys reales en el código fuente.
- `[ ]` Ejecución de prueba de `bun test` retorna `exitCode: 0`.
- `[ ]` Ruta absoluta accesible para el proceso que corre `fab run`.
