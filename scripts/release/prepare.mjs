import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run as defaultRun, root, readJson, writeJson } from './common.mjs';
import {
  cleanVersion,
  DEFAULT_REPO,
  formatPRList,
  getMergedPRs,
  getPreviousTag,
  readChangelog
} from './notes.mjs';

/**
 * Prepara los cambios locales para la PR de release:
 * - Actualiza package.json con la nueva versión
 * - Inserta la sección correspondiente en docs/CHANGELOG.md
 * - Genera el título y cuerpo propuestos para el PR de release
 *
 * @param {{
 *   version: string,
 *   dryRun?: boolean,
 *   allowAnyBranch?: boolean,
 *   createBranch?: boolean,
 *   runner?: Function,
 *   date?: string,
 *   repo?: string
 * }} options
 * @returns {Promise<{
 *   version: string,
 *   cleanVersion: string,
 *   previousTag: string|null,
 *   prs: Array<any>,
 *   prTitle: string,
 *   prBody: string,
 *   changelogUpdated: boolean,
 *   packageUpdated: boolean
 * }>}
 */
export async function prepareRelease({
  version,
  dryRun = false,
  allowAnyBranch = false,
  createBranch = false,
  runner = defaultRun,
  date,
  repo = DEFAULT_REPO
}) {
  const clean = cleanVersion(version);
  if (!clean) {
    throw new Error('Version argument is required');
  }

  const targetBranch = `release/${clean}`;
  let currentBranch = '';
  try {
    currentBranch = runner('git', ['branch', '--show-current']).trim();
  } catch {
    currentBranch = '';
  }

  if (currentBranch && currentBranch !== targetBranch) {
    if (createBranch) {
      runner('git', ['checkout', '-b', targetBranch]);
      currentBranch = targetBranch;
    } else if (!allowAnyBranch && !dryRun) {
      throw new Error(
        `Debes ejecutar este script en la rama '${targetBranch}' (rama actual: '${currentBranch}'). ` +
        `Crea la rama con 'git checkout -b ${targetBranch}' o utiliza --create-branch / --allow-any-branch.`
      );
    }
  }

  const prevTag = getPreviousTag('HEAD', runner);
  const prs = getMergedPRs({ fromRef: prevTag, toRef: 'HEAD', runner, repo });

  const today = date || new Date().toISOString().slice(0, 10);
  const changelogPrsText = formatPRList(prs);
  const changesContent = changelogPrsText
    ? `### Cambios incluidos\n${changelogPrsText}`
    : `### Cambios incluidos\n- Actualización de dependencias y mejoras internas.`;

  const newChangelogSection = `## [v${clean}] — ${today}\n\n${changesContent}`;

  const changelogPath = resolve(root, 'docs/CHANGELOG.md');
  const packagePath = resolve(root, 'package.json');

  let changelogUpdated = false;
  let packageUpdated = false;

  // Actualizar CHANGELOG.md
  const currentChangelog = await readFile(changelogPath, 'utf8');
  let updatedChangelog = currentChangelog;

  // Actualizar línea de versión actual en el encabezado si existe
  updatedChangelog = updatedChangelog.replace(
    /(hasta la versión actual \()(v?[^)]+)(\))/,
    `$1v${clean}$3`
  );

  // Insertar la nueva versión después del primer separador '---'
  const separatorMatch = /(^|\n)(---\n\n)/.exec(updatedChangelog);
  if (separatorMatch) {
    const insertPos = separatorMatch.index + separatorMatch[0].length;
    updatedChangelog =
      updatedChangelog.slice(0, insertPos) +
      newChangelogSection +
      '\n\n---\n\n' +
      updatedChangelog.slice(insertPos);
    changelogUpdated = true;
  } else {
    // Si no hay separador, agregar al principio después del título
    updatedChangelog = updatedChangelog + '\n\n---\n\n' + newChangelogSection + '\n';
    changelogUpdated = true;
  }

  if (!dryRun) {
    await writeFile(changelogPath, updatedChangelog, 'utf8');
  }

  // Actualizar package.json
  const pkg = await readJson(packagePath);
  pkg.version = clean;
  if (!dryRun) {
    await writeJson(packagePath, pkg);
    packageUpdated = true;
  }

  // Generar título y cuerpo del PR de release
  const prTitle = `release: v${clean}`;
  const prBodyParts = [
    `## Release v${clean}`,
    changesContent
  ];

  if (prevTag) {
    prBodyParts.push(`**Tag anterior:** ${prevTag}`);
    prBodyParts.push(`**Full Changelog:** https://github.com/${repo}/compare/${prevTag}...v${clean}`);
  }

  const prBody = prBodyParts.join('\n\n') + '\n';

  return {
    version,
    cleanVersion: clean,
    previousTag: prevTag,
    prs,
    prTitle,
    prBody,
    changelogUpdated,
    packageUpdated
  };
}

// Ejecución directa por CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const versionArg = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const createBranch = args.includes('--create-branch');
  const allowAnyBranch = args.includes('--allow-any-branch');

  if (!versionArg) {
    console.error('Uso: node scripts/release/prepare.mjs <versión> [--dry-run] [--create-branch] [--allow-any-branch]');
    process.exit(1);
  }

  try {
    const result = await prepareRelease({
      version: versionArg,
      dryRun,
      createBranch,
      allowAnyBranch
    });

    console.log('=== PR de Release ===');
    console.log(`Título: ${result.prTitle}\n`);
    console.log('Cuerpo:');
    console.log(result.prBody);

    if (dryRun) {
      console.log('\n[DRY RUN] No se modificaron archivos.');
    } else {
      console.log(`\nArchivos modificados: package.json (versión ${result.cleanVersion}) y docs/CHANGELOG.md.`);
      console.log('Siguiente paso: revisa el diff con git diff, realiza commit y crea la PR.');
    }
  } catch (err) {
    console.error(`Error al preparar la release: ${err.message}`);
    process.exit(1);
  }
}
