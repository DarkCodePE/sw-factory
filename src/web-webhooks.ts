// Vista web de webhooks y entregas del receptor (T87). Solo lectura.
// Muestra el estado del receptor de GitHub (T69b) y las entregas registradas.
// Invariantes de seguridad (D-K, §4): nunca se almacena ni se expone el cuerpo de la entrega
// ni el secreto en el HTML. El alta y la rotación de secretos residen en el entorno del dueño.
import type { Store, WebhookDelivery } from './store.ts';
import type { ConfigView } from './web-config.ts';

type Escape = (value: unknown) => string;

export const RESULT_LABELS: Record<string, string> = {
  woke: 'Aceptada (despertó)',
  coalesced: 'Coalescida (frecuencia)',
  ignored_event: 'Evento ignorado',
  ignored_repo: 'Repo ignorado',
};

function statusClass(result: string): string {
  if (result === 'woke') return 'completed';
  if (result === 'coalesced') return 'waiting_reply';
  return 'draft';
}

function facts(rows: [string, string][]): string {
  return `<dl class="config-facts">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

export function webhooksPage(store: Store, url: URL, escape: Escape, view?: ConfigView): { title: string; body: string } {
  if (!store.hasWebhookTables()) {
    return {
      title: 'Webhooks',
      body: `<div class="config">
        <section>
          <h2>Receptor de webhooks</h2>
          <p class="empty">Sin receptor</p>
          <p class="muted">Esta fábrica no tiene configuradas tablas de admisión ni receptor de webhooks.</p>
        </section>
      </div>`,
    };
  }

  const status = store.webhookReceptorStatus();
  const secretConfigured = !!(process.env.FAB_GITHUB_WEBHOOK_SECRET && process.env.FAB_GITHUB_WEBHOOK_SECRET.length >= 16);
  const deliveries = store.listWebhookDeliveries(200);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const filtered = q
    ? deliveries.filter(d =>
        d.delivery_id.toLowerCase().includes(q.toLowerCase()) ||
        d.event.toLowerCase().includes(q.toLowerCase()) ||
        d.result.toLowerCase().includes(q.toLowerCase()) ||
        (RESULT_LABELS[d.result] ?? '').toLowerCase().includes(q.toLowerCase()))
    : deliveries;

  const summary24h = status.last24h.length
    ? status.last24h.map(h => `${escape(RESULT_LABELS[h.result] ?? h.result)}: ${h.count}`).join(', ')
    : 'Sin entregas en las últimas 24 h';

  const deliveriesRows = filtered.map(d => {
    const label = RESULT_LABELS[d.result] ?? d.result;
    return `<tr>
      <td><code>${escape(d.delivery_id)}</code></td>
      <td>${escape(d.event)}</td>
      <td><time>${escape(d.received_at)}</time></td>
      <td>${escape(d.bytes)} B</td>
      <td><span class="status ${statusClass(d.result)}">${escape(label)}</span></td>
      <td><small class="muted">Sin cuerpo</small></td>
    </tr>`;
  }).join('');

  const deliveriesTable = filtered.length
    ? `<div class="table-wrap" role="region" aria-label="Entregas de webhooks" tabindex="0">
        <table>
          <thead>
            <tr>
              <th scope="col">ID de entrega</th>
              <th scope="col">Evento</th>
              <th scope="col">Fecha</th>
              <th scope="col">Tamaño</th>
              <th scope="col">Resultado</th>
              <th scope="col">Detalle</th>
            </tr>
          </thead>
          <tbody>${deliveriesRows}</tbody>
        </table>
      </div>`
    : `<p class="empty">${q ? 'Ninguna entrega coincide con la búsqueda.' : 'No hay entregas registradas.'}</p>`;

  const totalCount = status.totalDeliveries;
  const countLabel = totalCount > deliveries.length
    ? (q ? `${filtered.length} de ${deliveries.length} mostradas (de ${totalCount} en total)` : `${deliveries.length} de ${totalCount}`)
    : `${filtered.length}${q ? ` de ${deliveries.length}` : ''}`;

  const body = `<div class="config">
    <section>
      <h2>Estado del receptor</h2>
      ${facts([
        ['Estado del residente', status.active ? 'Activo' : 'Inactivo'],
        ['Estado del receptor', 'No medido (escucha en --hook-port)'],
        ['Ruta receptora local', '<code>POST /github</code> (solo loopback 127.0.0.1)'],
        ['Autenticación', 'Firma HMAC-SHA256 (<code>X-Hub-Signature-256</code>)'],
        ...(view && !view.credentials ? [] : [['Secreto en entorno (proceso web)', secretConfigured ? 'Configurado (FAB_GITHUB_WEBHOOK_SECRET)' : 'No configurado'] as [string, string]]),
        ['Eventos admitidos', '<code>issues</code>, <code>issue_comment</code>'],
        ['Entregas últimas 24 h', summary24h],
        ['Entregas rechazadas (sin firma válida)', status.rejectedCount ? `${escape(status.rejectedCount)}${status.lastRejectedAt ? ` (última: <time>${escape(status.lastRejectedAt)}</time>)` : ''}` : '0'],
        ['Última entrega', status.lastDeliveryAt ? `<time>${escape(status.lastDeliveryAt)}</time>` : 'Ninguna'],
      ])}
    </section>

    <section>
      <h2>Webhooks configurados</h2>
      <div class="table-wrap" role="region" aria-label="Webhooks configurados" tabindex="0">
        <table>
          <thead>
            <tr>
              <th scope="col">Webhook</th>
              <th scope="col">URL de destino</th>
              <th scope="col">Eventos</th>
              <th scope="col">Modo</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>GitHub (avisos)</strong></td>
              <td><code>POST /github</code> (puerto configurado con <code>--hook-port</code> del residente)</td>
              <td><code>issues</code>, <code>issue_comment</code></td>
              <td>Aviso (wake sin datos)</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted">El receptor escucha en el puerto fijado por <code>--hook-port</code> en el residente (no en el puerto de la web). Alta, rotación y túnel viven fuera de la web (D-K, §4). Solo lectura.</p>
    </section>

    <section>
      <h2>Entregas registradas (${countLabel})</h2>
      ${totalCount > deliveries.length ? `<p class="muted">Mostrando las ${deliveries.length} entregas más recientes de ${totalCount} registradas en la base.</p>` : ''}
      <form class="filters" action="/webhooks" method="get">
        <label class="search">Buscar entregas
          <input type="search" name="q" placeholder="Por ID, evento o resultado" value="${escape(q)}">
        </label>
        <button>Buscar</button>
        ${q ? '<a href="/webhooks">Limpiar filtro</a>' : ''}
      </form>
      ${deliveriesTable}
      <p class="muted">Por política de contención y seguridad (D-K, §4), fab registra solo metadatos de las entregas. El cuerpo nunca se almacena en la base ni se publica en la web.</p>
    </section>
  </div>`;

  return { title: 'Webhooks', body };
}
