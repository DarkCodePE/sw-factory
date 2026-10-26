import { run as defaultRun, root } from './common.mjs';
import {
  cleanVersion,
  DEFAULT_REPO,
  extractChangelogSection,
  generateReleaseNotes,
  getMergedPRs,
  getPreviousTag,
  readChangelog
} from './notes.mjs';

/**
 * Prepara o aplica notas enriquecidas para todas las releases existentes en GitHub.
 *
 * @param {{
 *   dryRun?: boolean,
 *   apply?: boolean,
 *   specificTag?: string,
 *   runner?: Function,
 *   repo?: string
 * }} options
 * @returns {Promise<Array<{ tag: string, version: string, notes: string, applied: boolean }>>}
 */
export async function backfillNotes({
  dryRun = true,
  apply = false,
  specificTag,
  runner = defaultRun,
  repo = DEFAULT_REPO
} = {}) {
  const isApply = apply && !dryRun;
  const changelog = await readChangelog().catch(() => '');

  let rawTags = '';
  try {
    rawTags = runner('git', ['tag', '--list', 'v*', '--sort=version:refname']);
  } catch {
    rawTags = '';
  }

  let tags = rawTags.split('\n').map(t => t.trim()).filter(Boolean);
  if (specificTag) {
    const cleanSpecific = specificTag.startsWith('v') ? specificTag : `v${specificTag}`;
    tags = tags.filter(t => t === cleanSpecific);
    if (tags.length === 0) {
      throw new Error(`Tag no encontrado: ${specificTag}`);
    }
  }

  const results = [];

  for (const tag of tags) {
    const version = cleanVersion(tag);
    const previousTag = getPreviousTag(tag, runner);
    const prs = getMergedPRs({ fromRef: previousTag, toRef: tag, runner, repo });
    const changelogSection = extractChangelogSection(changelog, version);

    let sourceSha = '';
    try {
      sourceSha = runner('git', ['rev-parse', `${tag}^{commit}`]).trim();
    } catch {
      sourceSha = '';
    }

    const notes = generateReleaseNotes({
      version,
      previousTag,
      changelogSection,
      prs,
      sourceSha,
      repo
    });

    if (isApply) {
      runner('gh', ['release', 'edit', tag, '--repo', repo, '--notes', notes]);
      results.push({ tag, version, notes, applied: true });
    } else {
      results.push({ tag, version, notes, applied: false });
    }
  }

  return results;
}

// Ejecución directa por CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const applyFlag = args.includes('--apply');
  const dryRunFlag = args.includes('--dry-run') || !applyFlag;

  const tagArgIndex = args.indexOf('--tag');
  const specificTag = tagArgIndex !== -1 ? args[tagArgIndex + 1] : undefined;

  try {
    const results = await backfillNotes({
      dryRun: dryRunFlag,
      apply: applyFlag,
      specificTag
    });

    if (dryRunFlag) {
      console.log('=== DRY RUN: NOTAS PREPARADAS PARA CADA RELEASE EXISTENTE ===\n');
      for (const item of results) {
        console.log('='.repeat(80));
        console.log(`TAG: ${item.tag}`);
        console.log('-'.repeat(80));
        console.log(item.notes.trim());
        console.log('='.repeat(80) + '\n');
      }
      console.log(`[DRY RUN] Se prepararon notas para ${results.length} tags existentes.`);
      console.log('No se editó ninguna release en GitHub.');
      console.log('Para aplicar los cambios reales, ejecuta: node scripts/release/backfill-notes.mjs --apply');
    } else {
      console.log(`[APPLY] Se actualizaron exitosamente ${results.length} releases en GitHub.`);
    }
  } catch (err) {
    console.error(`Error en backfill: ${err.message}`);
    process.exit(1);
  }
}
