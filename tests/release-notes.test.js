import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanVersion,
  extractChangelogSection,
  formatPRList,
  generateReleaseNotes,
  getMergedPRs,
  getPreviousTag
} from '../scripts/release/notes.mjs';
import { prepareRelease } from '../scripts/release/prepare.mjs';
import { backfillNotes } from '../scripts/release/backfill-notes.mjs';
import { buildReleaseNotesForReceipt } from '../scripts/release/publish-github.mjs';

const tempDirs = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const sampleChangelog = `# Registro de Cambios (\`CHANGELOG.md\`)

Historial detallado de versiones de \`sw-factory\` desde la etiqueta base \`c3eff63\` hasta la versión actual (v0.1.0-rc.10).

---

## [v0.1.0-rc.10] — 2026-10-24

### Novedades
- Router auto de modelos (-m auto)
- Aliases y routing de modelos

### Correcciones
- Solucionada fuga de memoria

---

## [v0.1.0-rc.9] — 2026-10-21 (\`f023e47\`)

### Novedades
- Modo YOLO por invocación (--yolo)
`;

test('cleanVersion normalizes version formats', () => {
  expect(cleanVersion('v0.1.0-rc.10')).toBe('0.1.0-rc.10');
  expect(cleanVersion('0.1.0-rc.10')).toBe('0.1.0-rc.10');
  expect(cleanVersion('  v1.2.3  ')).toBe('1.2.3');
  expect(cleanVersion('')).toBe('');
  expect(cleanVersion(null)).toBe('');
});

test('extractChangelogSection extracts target version section cleanly', () => {
  const rc10 = extractChangelogSection(sampleChangelog, '0.1.0-rc.10');
  expect(rc10).toContain('## [v0.1.0-rc.10] — 2026-10-24');
  expect(rc10).toContain('Router auto de modelos');
  expect(rc10).toContain('Solucionada fuga de memoria');
  expect(rc10).not.toContain('v0.1.0-rc.9');

  const rc9 = extractChangelogSection(sampleChangelog, 'v0.1.0-rc.9');
  expect(rc9).toContain('## [v0.1.0-rc.9] — 2026-10-21');
  expect(rc9).toContain('Modo YOLO por invocación');
  expect(rc9).not.toContain('v0.1.0-rc.10');

  const nonExistent = extractChangelogSection(sampleChangelog, 'v0.2.0');
  expect(nonExistent).toBe('');
});

test('getMergedPRs extracts PRs from git log without network', () => {
  const fakeGitLog = [
    'f0a4225\x1fMerge pull request #14 from DarkCodePE/fix/readme-facts\x1fdocs(readme): fix Jira variables\x1fOrlando Kuan\x1f58204194+DarkCodePE@users.noreply.github.com',
    '97accc4\x1fMerge pull request #13 from DarkCodePE/docs/readme-refresh\x1fdocs(readme): rework README with logo\x1fOrlando Kuan\x1f58204194+DarkCodePE@users.noreply.github.com',
    '516833e\x1fMerge pull request #12 from DarkCodePE/fix/public-npm-retry\x1ffix(release): retry npm view\x1fOrlando Kuan\x1fDarkCodePE@example.com'
  ].join('\n');

  const runner = (cmd, args) => {
    if (cmd === 'git') {
      expect(args[0]).toBe('log');
      return fakeGitLog;
    }
    if (cmd === 'gh') {
      throw new Error('gh command failed or offline');
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const prs = getMergedPRs({ fromRef: 'v0.1.0-rc.10', toRef: 'HEAD', runner });
  expect(prs.length).toBe(3);
  expect(prs[0]).toEqual({
    number: 14,
    title: 'docs(readme): fix Jira variables',
    author: 'DarkCodePE',
    url: 'https://github.com/DarkCodePE/sw-factory/pull/14',
    hash: 'f0a4225'
  });
  expect(prs[1].number).toBe(13);
  expect(prs[2].number).toBe(12);
  expect(prs[2].author).toBe('Orlando Kuan');
});

test('getMergedPRs enriches with gh pr list when available', () => {
  const fakeGitLog = 'f0a4225\x1fMerge pull request #14 from fix/branch\x1fOriginal body\x1fUser\x1fuser@example.com';
  const ghPrs = JSON.stringify([
    {
      number: 14,
      title: 'Enriched title from GitHub',
      author: { login: 'githubUser' },
      url: 'https://github.com/DarkCodePE/sw-factory/pull/14'
    }
  ]);

  const runner = (cmd, args) => {
    if (cmd === 'git') return fakeGitLog;
    if (cmd === 'gh') return ghPrs;
    throw new Error(`Unexpected: ${cmd}`);
  };

  const prs = getMergedPRs({ fromRef: 'v0.1.0-rc.10', toRef: 'HEAD', runner });
  expect(prs.length).toBe(1);
  expect(prs[0].title).toBe('Enriched title from GitHub');
  expect(prs[0].author).toBe('githubUser');
});

test('getPreviousTag calculates correct previous tag in sorted history', () => {
  const fakeTags = ['v0.1.0-rc.1', 'v0.1.0-rc.2', 'v0.1.0-rc.3'].join('\n');
  const runner = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'tag') return fakeTags;
    if (cmd === 'git' && args[0] === 'describe') return 'v0.1.0-rc.3';
    throw new Error(`Unexpected: ${cmd} ${args}`);
  };

  expect(getPreviousTag('v0.1.0-rc.3', runner)).toBe('v0.1.0-rc.2');
  expect(getPreviousTag('v0.1.0-rc.2', runner)).toBe('v0.1.0-rc.1');
  expect(getPreviousTag('v0.1.0-rc.1', runner)).toBe(null);
  expect(getPreviousTag('HEAD', runner)).toBe('v0.1.0-rc.3');
});

test('formatPRList produces structured markdown', () => {
  const prs = [
    { number: 10, title: 'feat(sdlc): connectors', author: 'DarkCodePE', url: 'https://github.com/DarkCodePE/sw-factory/pull/10' },
    { number: 11, title: 'fix(network): fallback', author: 'DarkCodePE' }
  ];

  const formatted = formatPRList(prs);
  expect(formatted).toBe(
    '- feat(sdlc): connectors ([#10](https://github.com/DarkCodePE/sw-factory/pull/10)) por @DarkCodePE\n' +
    '- fix(network): fallback (#11) por @DarkCodePE'
  );
  expect(formatPRList([])).toBe('');
});

test('generateReleaseNotes includes changelog, PRs, full changelog link, installation and sandbox warning', () => {
  const notes = generateReleaseNotes({
    version: '0.1.0-rc.11',
    previousTag: 'v0.1.0-rc.10',
    changelogSection: '### Novedades\n- Soporte para notas automáticas',
    prs: [
      { number: 14, title: 'docs(readme): fix Jira variables', author: 'DarkCodePE', url: 'https://github.com/DarkCodePE/sw-factory/pull/14' }
    ],
    sourceSha: 'abcdef1234567890abcdef1234567890abcdef12'
  });

  expect(notes).toContain('### Novedades\n- Soporte para notas automáticas');
  expect(notes).toContain('### Pull Requests');
  expect(notes).toContain('- docs(readme): fix Jira variables ([#14](https://github.com/DarkCodePE/sw-factory/pull/14)) por @DarkCodePE');
  expect(notes).toContain('**Full Changelog**: https://github.com/DarkCodePE/sw-factory/compare/v0.1.0-rc.10...v0.1.0-rc.11');
  expect(notes).toContain('npm install -g @okuanb/fab@0.1.0-rc.11');
  expect(notes).toContain('curl -fsSL https://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0-rc.11/install.sh | sh -s -- --version v0.1.0-rc.11');
  expect(notes).toContain('Source: abcdef1234567890abcdef1234567890abcdef12');
  expect(notes).toContain('Candidate and per-platform qualification receipts bind the exact published bytes. macOS has no tool sandbox equivalent; Linux isolation requires bubblewrap.');
});

test('prepareRelease checks branch, formats PR title and body in dry-run', async () => {
  const runner = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'branch') return 'release/0.1.0-rc.11';
    if (cmd === 'git' && args[0] === 'tag') return 'v0.1.0-rc.10';
    if (cmd === 'git' && args[0] === 'log') {
      return 'f0a4225\x1fMerge pull request #14 from branch\x1fdocs(readme): fix Jira variables\x1fOrlando Kuan\x1f58204194+DarkCodePE@users.noreply.github.com';
    }
    if (cmd === 'gh') throw new Error('offline');
    throw new Error(`Unexpected: ${cmd} ${args}`);
  };

  const res = await prepareRelease({
    version: '0.1.0-rc.11',
    dryRun: true,
    runner,
    date: '2026-10-25'
  });

  expect(res.cleanVersion).toBe('0.1.0-rc.11');
  expect(res.prTitle).toBe('release: v0.1.0-rc.11');
  expect(res.prBody).toContain('## Release v0.1.0-rc.11');
  expect(res.prBody).toContain('docs(readme): fix Jira variables');
  expect(res.prBody).toContain('**Tag anterior:** v0.1.0-rc.10');
  expect(res.prBody).toContain('https://github.com/DarkCodePE/sw-factory/compare/v0.1.0-rc.10...v0.1.0-rc.11');
  expect(res.changelogUpdated).toBe(true);
});

test('prepareRelease rejects incorrect branch unless allowed', async () => {
  const runner = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'branch') return 'main';
    return '';
  };

  await expect(prepareRelease({
    version: '0.1.0-rc.11',
    dryRun: false,
    runner
  })).rejects.toThrow("Debes ejecutar este script en la rama 'release/0.1.0-rc.11'");
});

test('backfillNotes dry-run generates notes without calling gh release edit', async () => {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'tag') return 'v0.1.0-rc.1\nv0.1.0-rc.2';
    if (cmd === 'git' && args[0] === 'describe') return 'v0.1.0-rc.1';
    if (cmd === 'git' && args[0] === 'rev-parse') return '1111222233334444555566667777888899990000';
    if (cmd === 'git' && args[0] === 'log') return '';
    if (cmd === 'gh') throw new Error('offline');
    return '';
  };

  const results = await backfillNotes({
    dryRun: true,
    runner
  });

  expect(results.length).toBe(2);
  expect(results[0].tag).toBe('v0.1.0-rc.1');
  expect(results[0].applied).toBe(false);
  expect(results[0].notes).toContain('npm install -g @okuanb/fab@0.1.0-rc.1');
  expect(results[1].tag).toBe('v0.1.0-rc.2');
  expect(results[1].applied).toBe(false);

  // Verificamos que NUNCA llamó a gh release edit
  const ghEdits = calls.filter(c => c.cmd === 'gh' && c.args.includes('edit'));
  expect(ghEdits.length).toBe(0);
});

test('backfillNotes apply invokes gh release edit with generated notes', async () => {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'tag') return 'v0.1.0-rc.1';
    if (cmd === 'git' && args[0] === 'rev-parse') return '1111222233334444555566667777888899990000';
    if (cmd === 'git' && args[0] === 'log') return '';
    if (cmd === 'gh' && args[0] === 'release' && args[1] === 'edit') return '';
    return '';
  };

  const results = await backfillNotes({
    dryRun: false,
    apply: true,
    runner
  });

  expect(results.length).toBe(1);
  expect(results[0].applied).toBe(true);
  const editCall = calls.find(c => c.cmd === 'gh' && c.args.includes('edit'));
  expect(editCall).toBeDefined();
  expect(editCall.args).toContain('v0.1.0-rc.1');
  expect(editCall.args).toContain('--notes');
});

test('buildReleaseNotesForReceipt constructs notes matching Candidate receipt', async () => {
  const receipt = {
    version: '0.1.0-rc.10',
    tag: 'v0.1.0-rc.10',
    sourceSha: 'fb93a01b44db4917c5863e3d35e34eeb7b1e7f0c',
    package: { filename: 'okuanb-fab-0.1.0-rc.10.tgz', name: '@okuanb/fab' }
  };

  const runner = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'tag') return 'v0.1.0-rc.9\nv0.1.0-rc.10';
    if (cmd === 'git' && args[0] === 'log') {
      return 'fb93a01\x1fMerge pull request #11 from fix/fetchurl\x1ffix(fetch-url): fallback\x1fOrlando Kuan\x1f58204194+DarkCodePE@users.noreply.github.com';
    }
    if (cmd === 'gh') throw new Error('offline');
    return '';
  };

  const notes = await buildReleaseNotesForReceipt(receipt, {
    changelog: sampleChangelog,
    runner
  });

  expect(notes).toContain('## [v0.1.0-rc.10] — 2026-10-24');
  expect(notes).toContain('Router auto de modelos');
  expect(notes).toContain('fix(fetch-url): fallback ([#11](https://github.com/DarkCodePE/sw-factory/pull/11)) por @DarkCodePE');
  expect(notes).toContain('**Full Changelog**: https://github.com/DarkCodePE/sw-factory/compare/v0.1.0-rc.9...v0.1.0-rc.10');
  expect(notes).toContain('npm install -g @okuanb/fab@0.1.0-rc.10');
  expect(notes).toContain('Source: fb93a01b44db4917c5863e3d35e34eeb7b1e7f0c');
});
