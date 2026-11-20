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

/** Trunca un Buffer UTF-8 respetando la frontera de carácter para no generar U+FFFD (T89-H4). */
export function safeTruncateUtf8(buf: Buffer, maxBytes: number): string {
  if (buf.byteLength <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  let i = end - 1;
  while (i >= 0 && i >= end - 4 && (buf[i] & 0xC0) === 0x80) {
    i--;
  }
  if (i >= 0 && (buf[i] & 0x80) !== 0) {
    const lead = buf[i];
    const seqLen = (lead & 0xE0) === 0xC0 ? 2
      : (lead & 0xF0) === 0xE0 ? 3
      : (lead & 0xF8) === 0xF0 ? 4 : 1;
    if (i + seqLen > end) {
      end = i;
    }
  }
  return buf.subarray(0, end).toString('utf8');
}

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
    const msg = (error as Error).message ?? '';
    const match = msg.match(/^([^ ]+) contiene una ruta local/);
    const detail = match
      ? `el fichero <code>${escape(match[1])}</code> contiene rutas locales no exportables.`
      : 'contiene rutas locales o referencias no exportables.';
    return {
      title: 'Definición',
      body: `<div class="config">
        ${selector}
        <section>
          <h2>Árbol de definición</h2>
          <div class="notice">
            <p>No se pudo generar el árbol de definición: ${detail}</p>
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
    const buf = Buffer.from(content, 'utf8');
    const byteLength = buf.byteLength;
    const isTruncated = byteLength > FILE_VIEW_LIMIT;
    const displayedText = isTruncated
      ? safeTruncateUtf8(buf, FILE_VIEW_LIMIT)
      : content;
    const warning = isTruncated
      ? `<p class="notice">Fichero grande truncado para visualización (mostrando ${Math.round(FILE_VIEW_LIMIT / 1024)} KiB de ${Math.round(byteLength / 1024)} KiB). El fichero íntegro se conserva en <code>fab definition export</code>.</p>`
      : '';

    return `<article id="file-${enc(path)}" class="definition-file">
      <h3>
        <code>${escape(path)}</code>
        <small>(${byteLength} bytes)</small>
      </h3>
      ${warning}
      <pre tabindex="0"><code>${escape(displayedText)}</code></pre>
    </article>`;
  }).join('');

  const body = `<div class="config">
    ${selector}

    <section>
      <h2>Árbol de definición · ${escape(selected.slug)}</h2>
      <div class="summary definition-summary">
        <span>Ficheros en el árbol: <strong>${files.size}</strong></span>
        <span>Workstream: <strong>${escape(selected.slug)}</strong></span>
        <span>Solo lectura</span>
      </div>
      <p class="muted">
        El árbol de definición se genera íntegramente en memoria y refleja el contenido de <code>fab definition export</code> (los secretos o credenciales detectados se muestran redactados por seguridad).
        No contiene rutas absolutas ni valores de entorno. Para editar o añadir ficheros, crea un Pull Request (catálogo §7.10).
      </p>

      <nav class="definition-nav" aria-label="Índice de ficheros de la definición">
        <h3>Ficheros</h3>
        <div class="quick">${quickLinks}</div>
      </nav>

      <div class="definition-tree">
        ${filesHtml}
      </div>
    </section>
  </div>`;

  return { title: 'Definición', body };
}
