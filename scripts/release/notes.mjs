import { run as defaultRun, root } from './common.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_REPO = 'DarkCodePE/sw-factory';

/**
 * Normaliza una versión quitando la 'v' inicial y espacios.
 * @param {string} v
 * @returns {string}
 */
export function cleanVersion(v) {
  return String(v || '').trim().replace(/^v/, '');
}

/**
 * Extrae la sección de CHANGELOG.md correspondiente a una versión.
 * @param {string} changelogContent
 * @param {string} version
 * @returns {string}
 */
export function extractChangelogSection(changelogContent, version) {
  const norm = cleanVersion(version);
  if (!changelogContent || !norm) return '';

  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)##\\s*\\[v?${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=(?:\\n##\\s*\\[|\\n---|$))`,
    'i'
  );
  const match = pattern.exec(changelogContent);
  if (!match) return '';
  return match[0].trim();
}

/**
 * Obtiene la lista de PRs fusionados entre dos referencias git.
 * Usa git log como fuente autoritativa y gh pr list para enriquecer metadata si está disponible.
 * @param {{ fromRef?: string, toRef?: string, runner?: Function, repo?: string }} options
 * @returns {Array<{ number: number, title: string, author: string, url: string, hash?: string }>}
 */
export function getMergedPRs({ fromRef, toRef = 'HEAD', runner = defaultRun, repo = DEFAULT_REPO } = {}) {
  const range = fromRef ? `${fromRef}..${toRef}` : toRef;
  let logOutput = '';
  try {
    logOutput = runner('git', ['log', range, '--merges', '--format=%H%x1f%s%x1f%b%x1f%an%x1f%ae']);
  } catch {
    return [];
  }

  const gitPrs = [];
  const entries = logOutput.split('\n').filter(Boolean);

  for (const entry of entries) {
    const [hash, subject = '', body = '', authorName = '', authorEmail = ''] = entry.split('\x1f');
    const prMatch = /Merge pull request #(\d+)/i.exec(subject)
      || /\(#(\d+)\)/.exec(subject)
      || /\(#(\d+)\)/.exec(body);

    if (!prMatch) continue;
    const prNumber = parseInt(prMatch[1], 10);

    // Obtener título: primer línea no vacía del body, o el subject
    const bodyLines = body.split('\n').map(s => s.trim()).filter(Boolean);
    let title = bodyLines[0] || subject;
    if (/^Merge pull request #\d+/i.test(title)) {
      title = `PR #${prNumber}`;
    }

    // Extraer autor de GitHub (ej. noreply email o autor del commit)
    let author = '';
    const noreplyMatch = /^(?:\d+\+)?([a-zA-Z0-9_-]+)@users\.noreply\.github\.com$/.exec(authorEmail.trim());
    if (noreplyMatch) {
      author = noreplyMatch[1];
    } else if (authorName) {
      author = authorName.trim();
    }

    gitPrs.push({
      number: prNumber,
      title,
      author,
      url: `https://github.com/${repo}/pull/${prNumber}`,
      hash
    });
  }

  // Intenta enriquecer con gh pr list si está disponible y hay conexión
  try {
    const ghOutput = runner('gh', [
      'pr', 'list',
      '--repo', repo,
      '--state', 'merged',
      '--limit', '100',
      '--json', 'number,title,author,url'
    ]);
    const ghPrList = JSON.parse(ghOutput);
    const ghMap = new Map(ghPrList.map(p => [p.number, p]));

    for (const pr of gitPrs) {
      const ghItem = ghMap.get(pr.number);
      if (ghItem) {
        if (ghItem.title) pr.title = ghItem.title;
        if (ghItem.author?.login) pr.author = ghItem.author.login;
        if (ghItem.url) pr.url = ghItem.url;
      }
    }
  } catch {
    // Si gh no está instalado o no hay red, la información de git log es suficiente
  }

  // Deduplicar por número de PR preservando orden
  const unique = [];
  const seen = new Set();
  for (const pr of gitPrs) {
    if (!seen.has(pr.number)) {
      seen.add(pr.number);
      unique.push(pr);
    }
  }

  return unique;
}

/**
 * Obtiene el tag previo a una referencia o tag dado.
 * @param {string} targetTagOrRef
 * @param {Function} runner
 * @returns {string|null}
 */
export function getPreviousTag(targetTagOrRef = 'HEAD', runner = defaultRun) {
  let tags = [];
  try {
    const raw = runner('git', ['tag', '--list', 'v*', '--sort=version:refname']);
    tags = raw.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;
  }

  if (tags.length === 0) return null;

  const cleanTarget = String(targetTagOrRef).trim().replace(/^refs\/tags\//, '');
  const index = tags.indexOf(cleanTarget);

  if (index > 0) {
    return tags[index - 1];
  }
  if (index === 0) {
    return null;
  }

  // Si no está exactamente en tags (ej. HEAD o rama), usamos describe o el último tag
  try {
    const ref = cleanTarget === 'HEAD' ? 'HEAD' : `${cleanTarget}^`;
    const desc = runner('git', ['describe', '--tags', '--abbrev=0', ref]);
    return desc.trim() || null;
  } catch {
    return tags[tags.length - 1] || null;
  }
}

/**
 * Formatea una lista de PRs en Markdown.
 * @param {Array<{ number: number, title: string, author?: string, url?: string }>} prs
 * @returns {string}
 */
export function formatPRList(prs) {
  if (!prs || prs.length === 0) return '';
  return prs.map(pr => {
    const prRef = pr.url ? `[#${pr.number}](${pr.url})` : `#${pr.number}`;
    const authorPart = pr.author ? ` por @${pr.author}` : '';
    return `- ${pr.title} (${prRef})${authorPart}`;
  }).join('\n');
}

/**
 * Genera el cuerpo de notas completas de una GitHub Release.
 * @param {{
 *   version: string,
 *   previousTag?: string|null,
 *   changelogSection?: string,
 *   prs?: Array<{ number: number, title: string, author?: string, url?: string }>,
 *   sourceSha?: string,
 *   repo?: string
 * }} options
 * @returns {string}
 */
export function generateReleaseNotes({
  version,
  previousTag,
  changelogSection,
  prs = [],
  sourceSha,
  repo = DEFAULT_REPO
}) {
  const norm = cleanVersion(version);
  const tag = `v${norm}`;
  const sections = [];

  // 1. Sección del CHANGELOG de esa versión si existe
  if (changelogSection && changelogSection.trim()) {
    sections.push(changelogSection.trim());
  }

  // 2. Lista de PRs si existen
  if (prs && prs.length > 0) {
    sections.push(`### Pull Requests\n\n${formatPRList(prs)}`);
  }

  // 3. Full Changelog diff link
  if (previousTag) {
    sections.push(`**Full Changelog**: https://github.com/${repo}/compare/${previousTag}...${tag}`);
  }

  // 4. Instrucciones de instalación
  sections.push(`### Instalación

\`\`\`bash
npm install -g @okuanb/fab@${norm}
\`\`\`

Instalador directo:
\`\`\`bash
curl -fsSL https://github.com/${repo}/releases/download/${tag}/install.sh | sh -s -- --version ${tag}
\`\`\``);

  // 5. Verificación de fuente y sandbox notice
  if (sourceSha) {
    sections.push(`Source: ${sourceSha}\nCandidate and per-platform qualification receipts bind the exact published bytes. macOS has no tool sandbox equivalent; Linux isolation requires bubblewrap.`);
  } else {
    sections.push(`Candidate and per-platform qualification receipts bind the exact published bytes. macOS has no tool sandbox equivalent; Linux isolation requires bubblewrap.`);
  }

  return sections.join('\n\n') + '\n';
}

/**
 * Lee el archivo CHANGELOG.md de la raíz del proyecto.
 * @returns {Promise<string>}
 */
export async function readChangelog() {
  return await readFile(resolve(root, 'docs/CHANGELOG.md'), 'utf8');
}
