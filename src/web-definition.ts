// Vista web del árbol de definición de un workstream (T89). Solo lectura.
// Genera el árbol en memoria mediante buildDefinition() (src/definition.ts) y muestra el contenido de cada fichero.
// Invariantes de diseño (catálogo §7.10):
// - Sin edición ni subida en la web: cambiar es un PR.
// - No escribe en disco: genera el árbol en memoria.
// - Coincide exactamente con `fab definition export`.
// - El árbol no contiene rutas absolutas ni valores de entorno (D-K).
// - Un fichero grande se trunca con aviso visible.
import { buildDefinition } from './definition.ts';
import type { Store } from './store.ts';

type Escape = (value: unknown) => string;

/** Límite de visualización por fichero en la web (32 KiB). Si se supera, se trunca con aviso. */
export const FILE_VIEW_LIMIT = 32 * 1024;

const enc = encodeURIComponent;

export function definitionPage(store: Store, stateDir: string | undefined, url: URL, escape: Escape): { title: string; body: string } {
  const workstreams = store.listWorkstreams();
  if (!workstreams.length) {
    return {
      title: 'Definición',
      body: '<div class="config"><p class="empty">No hay workstreams.</p></div>',
    };
  }

  const wsParam = url.searchParams.get('ws');
  const selected = wsParam ? workstreams.find(w => w.slug === wsParam) : workstreams[0];
  if (!selected) {
    return {
      title: 'Definición',
      body: `<div class="config">
        <p class="notice">Workstream no encontrado: ${escape(wsParam)}</p>
        <p><a href="/definicion">Volver a la definición por defecto</a></p>
      </div>`,
    };
  }

  const selector = `
    <form class="filters" action="/definicion" method="get">
      <label>Workstream
        <select name="ws">
          ${workstreams.map(w => `<option value="${escape(w.slug)}"${w.slug === selected.slug ? ' selected' : ''}>${escape(w.slug)}</option>`).join('')}
        </select>
      </label>
      <button>Ver definición</button>
    </form>`;

  let files: Map<string, string>;
  try {
    files = buildDefinition(store, stateDir, selected.slug);
  } catch (error) {
    return {
      title: 'Definición',
      body: `<div class="config">
        ${selector}
        <section>
          <h2>Árbol de definición</h2>
          <div class="notice">
            <p>No se pudo generar el árbol de definición: ${escape((error as Error).message)}</p>
          </div>
        </section>
      </div>`,
    };
  }

  const sortedPaths = [...files.keys()].sort();
  const quickLinks = sortedPaths.map(p =>
    `<a href="#file-${enc(p)}"><code>${escape(p)}</code></a>`,
  ).join('');

  const filesHtml = sortedPaths.map(path => {
    const content = files.get(path) ?? '';
    const byteLength = Buffer.byteLength(content, 'utf8');
    const isTruncated = byteLength > FILE_VIEW_LIMIT;
    const displayedText = isTruncated
      ? Buffer.from(content, 'utf8').subarray(0, FILE_VIEW_LIMIT).toString('utf8')
      : content;
    const warning = isTruncated
      ? `<p class="notice">Fichero grande truncado para visualización (mostrando ${Math.round(FILE_VIEW_LIMIT / 1024)} KiB de ${Math.round(byteLength / 1024)} KiB). El fichero íntegro se conserva en <code>fab definition export</code>.</p>`
      : '';

    return `<article id="file-${enc(path)}" class="definition-file" style="margin-bottom: 24px; border-bottom: 1px solid var(--line); padding-bottom: 20px;">
      <h3 style="font-size: 16px; margin: 16px 0 8px;">
        <code>${escape(path)}</code>
        <small style="display: inline; margin-left: 8px;">(${byteLength} bytes)</small>
      </h3>
      ${warning}
      <pre tabindex="0"><code>${escape(displayedText)}</code></pre>
    </article>`;
  }).join('');

  const body = `<div class="config">
    ${selector}

    <section>
      <h2>Árbol de definición · ${escape(selected.slug)}</h2>
      <div class="summary" style="margin-bottom: 16px;">
        <span>Ficheros en el árbol: <strong>${files.size}</strong></span>
        <span>Workstream: <strong>${escape(selected.slug)}</strong></span>
        <span>Solo lectura</span>
      </div>
      <p class="muted">
        El árbol de definición se genera íntegramente en memoria y coincide con <code>fab definition export</code>.
        No contiene rutas absolutas ni valores de entorno. Para editar o añadir ficheros, crea un Pull Request (catálogo §7.10).
      </p>

      <nav aria-label="Índice de ficheros de la definición" style="margin: 16px 0 24px;">
        <h3 style="font-size: 14px; color: var(--muted); margin-bottom: 8px;">Ficheros</h3>
        <div class="quick">${quickLinks}</div>
      </nav>

      <div class="definition-tree">
        ${filesHtml}
      </div>
    </section>
  </div>`;

  return { title: 'Definición', body };
}
