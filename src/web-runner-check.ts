import { join } from 'node:path';
import { checkRunner, RunnerError, type RemoteDeps, type RemoteRunner, type RunnerCheck, type Transport } from './runners/client.ts';
import { isRunnerName, Store, StoreError } from './store.ts';

export interface RunnerCheckOptions {
  transport?: Transport;
  timer?: RemoteDeps['timer'];
}

export const RUNNER_CHECK_PATH = /^\/config\/runners\/([^/]+)\/comprobar$/;

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function result(title: string, status: number, details = '', back = { href: '/config/runners', text: 'Volver a runners' }): Response {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>Comprobación de runner · fab</title>
    <link rel="stylesheet" href="/style.css"></head><body><aside>
    <a class="brand" href="/">fab<span>Fábrica local</span></a>
    <nav aria-label="Configuración"><a href="${back.href}">${back.text}</a></nav></aside>
    <main class="config"><h1>${title}</h1>${details}</main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function declared(name: string, check: RunnerCheck): string {
  const agents = Object.entries(check.agents).map(([name, agent]) =>
    `<li>${escape(name)} · <code>${escape(agent.sha256.slice(0, 12))}</code></li>`).join('');
  return `<p><code>${escape(name)}</code> · Protocolo ${check.protocol}</p><section><h2>Declarado por el runner, no verificado</h2>
    <dl class="config-facts"><div><dt>Versión de fab</dt><dd><code>${escape(check.fabSha)}</code></dd></div>
    <div><dt>Sandbox</dt><dd>${escape(check.sandbox)}</dd></div></dl>
    ${agents ? `<h3>Adaptadores · SHA-256 abreviado</h3><ul>${agents}</ul>` : '<p>Sin adaptadores declarados.</p>'}</section>`;
}

/** Una instancia por servidor. WebAuth solo emite una sesión por arranque. */
export function runnerCheckAction(stateDir: string, options: RunnerCheckOptions = {}) {
  let checking = false;
  return async (name: string, extendTimeout: () => void): Promise<Response> => {
    if (!isRunnerName(name)) return result('Nombre de runner inválido', 400);
    if (checking) return result('Ya hay una comprobación en curso', 409);

    let runner: RemoteRunner;
    try {
      const store = new Store(join(stateDir, 'fabrica.db'), { readonly: true });
      try {
        const row = store.getRunner(name);
        if (!row.enabled) return result('El runner está pausado', 409);
        if (row.kind !== 'ssh' || !row.target) return result('La comprobación solo se ofrece para runners SSH', 400);
        runner = { name: row.name, target: row.target };
      } finally { store.close(); }
    } catch (error) {
      if (error instanceof StoreError && error.code === 'not_found') return result('Runner no encontrado', 404);
      return result('No se pudo leer la configuración del runner', 500);
    }

    checking = true;
    try {
      extendTimeout();
      const check = await checkRunner(runner, options.transport, { timer: options.timer });
      return result('SSH alcanzable', 200, declared(name, check));
    } catch (error) {
      if (error instanceof RunnerError) {
        if (error.reason === 'timeout') return result('Tiempo de comprobación agotado', 504);
        if (error.reason === 'invalid_hello') return result('Protocolo incompatible', 502);
        if (error.code === 'RUNNER_BUSY') return result('El runner está ocupado', 409);
      }
      return result('Runner inaccesible', 502);
    } finally { checking = false; }
  };
}
