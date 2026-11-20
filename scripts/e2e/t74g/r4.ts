#!/usr/bin/env bun
// T74g · ataque a R4 (T74 §8): el sellado lee lo que dejó el agente en su clon. Cada escenario instala en el PATH del
// runner un `claude` hostil (el adaptador real `claude` lo lanza confinado con bwrap), pasa por ssh falso → `fab runner serve`
// → bundle de ida → agente → sealResult → bundle de vuelta → importResult en casa. Se mira qué llegó a casa, si algo se
// ejecutó fuera del sandbox (testigos en $W) y qué queda en el runner.
// Uso: bun r4.ts [dir-temporal] [escenario…]. Sale con 1 si algún escenario incumple su expectativa.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerError, runRemoteAgent } from '../../../src/runners/client.ts';

const HERE = import.meta.dir;
const CLI = resolve(HERE, '../../../src/cli.ts');
const dir = mkdtempSync(join(process.argv[2] ?? join(tmpdir(), 't74g-r4-'), ''));
const only = process.argv.slice(3);
const W = join(dir, 'witness'); // fuera del clon y del sandbox: si algo se crea aquí, el runner ejecutó lo que dejó el agente
const run = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const git = (cwd: string, ...a: string[]) => run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], cwd).out;

type Sc = {
  name: string; why: string; body: string;
  /** imported = llega un commit; rejected = RunnerError; nochange = sin commit. */
  expect: 'imported' | 'rejected' | 'nochange'; check?: (c: Ctx) => string[];
};
type Ctx = { wt: string; head: string; sha: string | null; err: string | null; ms: number };

// Cargas hostiles. Se ejecutan con /bin/sh dentro del sandbox, con cwd = el clon del runner.
const EVIL_CFG = (extra = '') => `
cat >> .git/config <<EOC
[core]
	fsmonitor = touch ${W}/fsmonitor
	hooksPath = ${W}/hooks
	sshCommand = touch ${W}/sshcommand
	editor = touch ${W}/editor
	pager = touch ${W}/pager
[filter "pwn"]
	clean = touch ${W}/clean-filter
	smudge = touch ${W}/smudge-filter
	process = touch ${W}/process-filter
[diff "pwn"]
	textconv = touch ${W}/textconv
[alias]
	add = !touch ${W}/alias
[gc]
	auto = 1
	autoDetach = false
[receive]
	fsckObjects = false
[uploadpack]
	packObjectsHook = touch ${W}/packhook
EOC
${extra}`;
const NESTED_CFG = `
cat >> sub/.git/config <<EOC
[core]
	fsmonitor = touch ${W}/nested-fsmonitor
	hooksPath = ${W}/hooks
[filter "pwn"]
	clean = touch ${W}/nested-clean
EOC`;

const SCENARIOS: Sc[] = [
  { name: 'base', why: 'control: un fichero nuevo y uno modificado, sin trucos', expect: 'imported',
    body: `echo nuevo > nuevo.txt; echo cambio >> README.md`,
    check: c => [!existsSync(join(c.wt, 'nuevo.txt')) && 'falta nuevo.txt'].filter(Boolean) as string[] },
  { name: 'clone-git-envenenado', why: 'A4/R4: .git/config del clon con fsmonitor, hooksPath, filtro clean/smudge/process, alias, sshCommand; hook pre-commit; .gitattributes que lo activa; commit propio en el clon', expect: 'imported',
    body: `${EVIL_CFG(`mkdir -p .git/hooks; printf '#!/bin/sh\\ntouch ${W}/hook-pre-commit\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit
printf '* filter=pwn diff=pwn\\n' > .gitattributes
echo x > x.txt; git add -A; git commit -qm propio-del-agente --no-verify; echo y > y.txt`)}`,
    check: c => {
      const e: string[] = [];
      if (git(c.wt, 'rev-parse', 'HEAD^') !== c.head) e.push('el padre no es el head enviado');
      if (git(c.wt, 'rev-list', '--count', `${c.head}..HEAD`) !== '1') e.push('más de un commit');
      if (git(c.wt, 'log', '-1', '--format=%s') === 'propio-del-agente') e.push('llegó el commit del agente');
      for (const f of ['x.txt', 'y.txt']) if (!existsSync(join(c.wt, f))) e.push(`falta ${f}`);
      return e;
    } },
  { name: 'git-anidado-con-commit', why: 'R4: sub/.git es un repo completo con commit y config hostil; `add -A` lo vería como gitlink', expect: 'rejected',
    body: `mkdir sub; cd sub; git init -q; echo a > a; git add a; git commit -qm n; cd ..; ${NESTED_CFG}; echo ok > fuera.txt` },
  { name: 'git-anidado-vacio', why: 'R4: sub/.git sin ningún commit (git add -A lo trata distinto)', expect: 'rejected',
    body: `mkdir sub; git init -q sub; echo contenido > sub/a; echo ok > fuera.txt` },
  { name: 'git-anidado-gitfile', why: 'R4: sub/.git es un fichero `gitdir: <caché del runner>`: que git lea la caché como repo embebido (se ignora por nombre: llega sin él)', expect: 'imported',
    body: `mkdir sub; echo "gitdir: ${join(dir, 'root', 'cache')}" > sub/.git; echo contenido > sub/a; echo ok > fuera.txt` },
  { name: 'git-anidado-sin-nada', why: 'R4: sub/.git es un directorio vacío o sin HEAD válido', expect: 'imported',
    body: `mkdir -p sub/.git; echo contenido > sub/a; echo ok > fuera.txt`,
    check: c => [existsSync(join(c.wt, 'sub', '.git')) && 'un .git anidado llegó a casa'].filter(Boolean) as string[] },
  { name: 'symlinks-varios', why: 'R4: symlinks absolutos, relativos hacia fuera, colgantes, a la caché, en bucle, a .git', expect: 'imported',
    body: `ln -s /etc/passwd abs-passwd; ln -s ../../../../etc rel-etc; ln -s no-existe colgante; ln -s ${join(dir, 'root', 'cache')} a-la-cache; ln -s . bucle; ln -s .git a-dot-git; mkdir d; ln -s ../README.md d/rel-ok; echo ok > f.txt`,
    check: c => {
      const e: string[] = [];
      for (const n of ['abs-passwd', 'rel-etc', 'colgante', 'a-la-cache', 'bucle', 'a-dot-git']) {
        const p = join(c.wt, n);
        if (!lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) e.push(`${n} no llegó como symlink`);
      }
      if (existsSync(join(c.wt, '.git')) && lstatSync(join(c.wt, '.git')).isSymbolicLink()) e.push('.git de casa es symlink');
      return e;
    } },
  { name: 'gitmodules-symlink', why: 'R4: .gitmodules como symlink (clase CVE-2018-11235 / fsck gitmodulesSymlink) y un `.gitmodules` con url hostil', expect: 'rejected',
    body: `ln -s /etc/passwd .gitmodules; echo ok > f.txt` },
  { name: 'gitmodules-url', why: 'R4: .gitmodules regular con submódulo `ext::` / ruta ../ (no hay gitlink: solo texto)', expect: 'imported',
    body: `printf '[submodule "x"]\\n\\tpath = x\\n\\turl = ext::sh -c "touch ${W}/ext"\\n' > .gitmodules; echo ok > f.txt` },
  { name: 'attributes-symlink', why: 'R4: .gitattributes y .gitignore como symlinks fuera', expect: 'imported',
    body: `ln -s /etc/passwd .gitattributes; ln -s /etc/passwd .gitignore; echo ok > f.txt` },
  { name: 'fifo-socket', why: 'R4: fichero FIFO y socket unix (un open bloqueante colgaría el sellado)', expect: 'imported',
    body: `mkfifo fifo; python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind('sock')"; echo ok > f.txt`,
    check: c => [existsSync(join(c.wt, 'fifo')) && 'el FIFO llegó a casa', existsSync(join(c.wt, 'sock')) && 'el socket llegó a casa'].filter(Boolean) as string[] },
  { name: 'nombres-raros', why: 'R4: nombres con salto de línea, bytes no UTF-8, guion inicial, espacios, 250 bytes, `\\`', expect: 'imported',
    body: `printf x > "$(printf 'sal\\nto')"; printf x > "$(printf 'inv\\377alido')"; printf x > ./-rf; printf x > ./--help; printf x > "con espacios  "; printf x > "$(head -c 250 /dev/zero | tr '\\0' n)"; printf x > 'a\\b'; printf x > ':colon'; printf x > '$(touch ${W}/subst)'; printf x > '\`touch ${W}/bq\`'; echo ok > f.txt`,
    check: c => [existsSync(W) && readdirSync(W).length ? `testigos: ${readdirSync(W)}` : ''].filter(Boolean) as string[] },
  { name: 'dotgit-variantes', why: 'R4: `.GIT/config`, `.git /x`, `.git.`, `git~1` (los de NTFS/HFS que fsck rechaza)', expect: 'rejected',
    body: `mkdir -p .GIT; echo x > .GIT/config; echo ok > f.txt` },
  { name: 'dotgit-ntfs', why: 'R4: `git~1/x` (nombre corto NTFS de .git): git add lo rechaza (protectNTFS), falla cerrado', expect: 'rejected',
    body: `mkdir -p 'git~1'; echo x > 'git~1/x'; echo ok > f.txt` },
  { name: 'gitignore-todo', why: 'R4: .gitignore con `*` esconde el trabajo (no es inyección: el resultado es «sin cambios», se anota)', expect: 'nochange',
    body: `echo '*' > .gitignore; echo ok > f.txt`,
    check: c => [existsSync(join(c.wt, 'f.txt')) ? 'f.txt (ignorado) llegó' : ''].filter(Boolean) as string[] },
  { name: 'attrs-conversion', why: 'R4: .gitattributes con filter=pwn, ident, working-tree-encoding=UTF-16, export-subst y eol=crlf: git add falla (UTF-16 exige BOM), falla cerrado', expect: 'rejected',
    body: `printf '* filter=pwn ident working-tree-encoding=UTF-16 eol=crlf\\n*.md export-subst\\n' > .gitattributes; echo 'hola $Id$' > f.txt` },
  { name: 'esparcido-2g', why: 'R4/DoS: fichero disperso de 2 GiB (git add lo lee entero)', expect: 'imported',
    body: `truncate -s 2G grande.bin; echo ok > f.txt` },
  { name: 'aleatorio-80m', why: 'R4/DoS: 80 MiB incompresibles: supera el tope de vuelta de 64 MiB', expect: 'rejected',
    body: `head -c 83886080 /dev/urandom > grande.bin; echo ok > f.txt` },
  { name: 'muchos-ficheros', why: 'R4/DoS: 30 000 ficheros pequeños', expect: 'imported',
    body: `mkdir m; i=0; while [ $i -lt 30000 ]; do echo $i > m/f$i; i=$((i+1)); done` },
  { name: 'profundidad', why: 'R4: 300 niveles de directorios', expect: 'imported',
    body: `p=.; i=0; while [ $i -lt 300 ]; do p=$p/d; i=$((i+1)); done; mkdir -p $p; echo ok > $p/f` },
  { name: 'escritor-tardio', why: 'R4: procesos en segundo plano que siguen escribiendo en el clon tras terminar el agente (setsid, nohup)', expect: 'imported',
    body: `echo ok > f.txt; (setsid sh -c 'while :; do date +%s%N >> tardio.txt; done' >/dev/null 2>&1 &) ; nohup sh -c 'while :; do date +%s%N >> tardio2.txt; done' >/dev/null 2>&1 & sleep 0.3` },
  { name: 'exec-bits', why: 'R4: setuid/setgid/sticky y modo 777', expect: 'imported',
    body: `echo '#!/bin/sh' > s.sh; chmod 4777 s.sh; echo x > g; chmod 2755 g; echo ok > f.txt` },
  { name: 'ansi-informe', why: 'A12: el informe del agente lleva secuencias de escape y <script>', expect: 'nochange',
    body: ``, check: c => [] },
];

const claudeShim = (body: string, report = 'listo') => `#!/bin/sh
# claude hostil de T74g: ignora los argumentos y deja lo suyo en el clon (cwd).
cat >/dev/null
${body}
printf '%s\\n' '{"type":"result","result":${JSON.stringify(report)},"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'
`;

let failed = 0;
const rows: string[] = [];
for (const sc of SCENARIOS) {
  if (only.length && !only.includes(sc.name)) continue;
  const tmp = join(dir, sc.name); mkdirSync(join(tmp, 'rbin'), { recursive: true }); mkdirSync(join(tmp, 'log')); mkdirSync(join(tmp, 'rhome')); mkdirSync(W, { recursive: true });
  for (const f of readdirSync(W)) rmSync(join(W, f), { recursive: true, force: true });
  const home = join(tmp, 'home'), wt = join(tmp, 'wt'), root = join(tmp, 'root');
  mkdirSync(home); git(home, 'init', '-q', '-b', 'main'); writeFileSync(join(home, 'README.md'), '# demo\n'); writeFileSync(join(home, 'calc.py'), 'x = 1\n');
  git(home, 'add', '-A'); git(home, 'commit', '-q', '-m', 'base'); const head = git(home, 'rev-parse', 'HEAD'); git(home, 'worktree', 'add', '-q', '-b', 'fab/change', wt);
  const report = sc.name === 'ansi-informe' ? '\u001b]0;pwned\u0007\u001b[2J<script>alert(1)</script>' : 'listo';
  const body = sc.name === 'ansi-informe' ? 'echo ok > f.txt' : sc.body;
  writeFileSync(join(tmp, 'rbin', 'claude'), claudeShim(body.replaceAll(join(dir, 'root'), root), report)); chmodSync(join(tmp, 'rbin', 'claude'), 0o755);
  // el `ssh` falso lleva el root de este escenario
  const sh = Bun.spawnSync([join(HERE, 'install-fake-ssh.sh'), join(tmp, 'bin'), join(tmp, 'log'), join(tmp, 'rhome'), `${join(tmp, 'rbin')}:/usr/local/bin:/usr/bin:/bin`, root, CLI]);
  if (sh.exitCode !== 0) throw new Error(sh.stderr.toString());
  process.env.PATH = `${join(tmp, 'bin')}:${process.env.PATH!.split(':').filter(p => !p.includes('t74g-r4')).join(':')}`;
  const t0 = Date.now(); let sha: string | null = null, err: string | null = null, output = '';
  try {
    const r = await runRemoteAgent({ name: 'torre', target: 'torre' }, {
      activityId: 'act1', attempt: 1, adapter: 'claude', model: null, readOnly: false, expectChanges: true, prompt: 'haz algo',
      repo: home, worktree: wt, head, base: head, timeoutMs: 240_000, repoKey: 'a'.repeat(64),
    });
    output = r.output; sha = git(wt, 'rev-parse', 'HEAD') !== head ? git(wt, 'rev-parse', 'HEAD') : null;
  } catch (e) { err = e instanceof RunnerError ? e.message : `EXCEPCIÓN ${(e as Error).message}`; }
  const ms = Date.now() - t0;
  const outcome = err ? 'rejected' : sha ? 'imported' : 'nochange';
  const problems: string[] = [];
  if (outcome !== sc.expect) problems.push(`esperado ${sc.expect}, obtenido ${outcome}`);
  if (err?.startsWith('EXCEPCIÓN')) problems.push(err);
  const wit = existsSync(W) ? readdirSync(W) : [];
  if (wit.length) problems.push(`EJECUCIÓN FUERA DEL SANDBOX: ${wit.join(',')}`);
  // casa: worktree consistente (limpio y en head o en el commit importado), rama del change sin más commits
  const st = git(wt, 'status', '--porcelain', '--untracked-files=all');
  if (st) problems.push(`worktree de casa sucio: ${st.split('\n').slice(0, 3).join(' | ')}`);
  if (git(home, 'rev-list', '--count', `${head}..fab/change`) !== (sha ? '1' : '0')) problems.push('n.º de commits en la rama del change');
  if (git(home, 'rev-parse', 'main') !== head) problems.push('main cambió');
  if (git(home, 'for-each-ref', 'refs/fab/').length) problems.push(`refs/fab/ sin limpiar: ${git(home, 'for-each-ref', 'refs/fab/')}`);
  // runner: nada de encargos, bloqueos ni bundles; ningún proceso del escenario
  // El runner limpia después de enviar el resultado: se espera (por condición, hasta 20 s) a que acabe.
  const leftovers = () => {
    const left = existsSync(root) ? [...(existsSync(join(root, 'jobs')) ? readdirSync(join(root, 'jobs')) : []), ...readdirSync(root).filter(n => n.startsWith('in-'))] : [];
    const ps = run(['ps', '-eo', 'args']).out.split('\n').filter(l => !l.includes('shell-snapshots') && (l.includes(tmp) || l.includes('tardio')));
    return { left, ps };
  };
  let lo = leftovers();
  for (let i = 0; i < 400 && (lo.left.length || lo.ps.length); i++) { await Bun.sleep(50); lo = leftovers(); }
  if (lo.left.length) problems.push(`restos en el runner tras 20 s: ${lo.left}`);
  if (lo.ps.length) problems.push(`procesos vivos tras 20 s: ${lo.ps.length}`);
  if (sc.name === 'escritor-tardio') {
    const f = join(wt, 'tardio.txt'); const s1 = existsSync(f) ? lstatSync(f).size : -1; await Bun.sleep(300);
    const s2 = existsSync(f) ? lstatSync(f).size : -1; if (s1 !== s2) problems.push('el escritor tardío sigue escribiendo en el worktree de casa');
  }
  if (sc.name === 'ansi-informe') {
    if (/[\u001b\u0007]/.test(output) === false) problems.push('el informe llegó sin los escapes (¿se sanea o no hay informe?)'); // el saneo es de quien lo muestra (A12): aquí solo se anota
    else problems.pop();
  }
  const extra = outcome === 'imported' && sc.check ? sc.check({ wt, head, sha, err, ms }) : [];
  problems.push(...extra.filter(Boolean));
  const tree = sha ? git(wt, 'diff-tree', '-r', '--no-commit-id', '--name-status', head, sha).split('\n').length : 0;
  rows.push(`${problems.length ? 'FALLO' : 'OK   '} ${sc.name.padEnd(24)} ${outcome.padEnd(9)} ${String(ms).padStart(6)} ms  ${err ?? `entradas=${tree}`}${problems.length ? '\n        ⚠ ' + problems.join('\n        ⚠ ') : ''}`);
  if (problems.length) failed++;
  rmSync(join(tmp, 'home'), { recursive: true, force: true });
}
console.log(rows.join('\n')); console.log(`\n${failed ? `${failed} escenario(s) con incumplimientos` : 'todos los escenarios cumplen su expectativa'}  (${dir})`);
process.exit(failed ? 1 : 0);
