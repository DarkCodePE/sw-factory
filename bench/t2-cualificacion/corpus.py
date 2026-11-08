#!/usr/bin/env python3
"""Corpus T2: 10 repos de GitHub x 10 tareas por mutacion. Solo biblioteca estandar.

  corpus.py clonar    <upstream>             clona cada repo en su commit y comprueba la licencia
  corpus.py calificar <upstream> [repo ...]  candidatas/<repo>.json -> mutaciones/<repo>.json + descartadas.json
  corpus.py preparar  <destino>              repos de tarea (1 commit, sin tests ocultos), ocultos/ y suite.json
  corpus.py validar   <destino>              verify falla en la base y pasa con la referencia -> validacion.json

La red solo se usa en `clonar`. Con T2_UPSTREAM=<dir> se reutilizan clones ya fijados al commit.
"""
import concurrent.futures as cf, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile, time
from pathlib import Path

AQUI = Path(__file__).resolve().parent
FECHA = "2026-01-01T00:00:00Z"
GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"]
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
# La descripcion cuenta el sintoma; no puede nombrar tests ni el archivo mutado.
REVELA = re.compile(r"\btests?\b|\bpytest\b|\bunittest\b|\bdiff\b|\bl[ií]nea\b|\.py\b", re.I)
SPLIT_VALIDACION = 2  # las dos ultimas tareas de cada repo


def fallo(msg):
    sys.exit(f"error: {msg}")


def repos():
    return [json.loads(p.read_text()) for p in sorted((AQUI / "repos").glob("*.json"))]


def leer(p):
    return json.loads(Path(p).read_text())


def escribir(p, obj):
    Path(p).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def git(cwd, *args, env=None, check=True):
    r = subprocess.run([*GIT, "-C", str(cwd), *args], capture_output=True, text=True, env=env)
    if check and r.returncode:
        fallo(f"git {' '.join(args)} en {cwd}: {r.stderr.strip()}")
    return r.stdout.strip()


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---------- clonar ----------
def clonar_uno(repo, up):
    d = Path(up) / repo["nombre"]
    ok = (d / ".git").exists() and subprocess.run([*GIT, "-C", str(d), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip() == repo["commit"]
    if not ok:
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        for args in (["init", "-q"], ["fetch", "-q", "--depth", "1", repo["url"], repo["commit"]], ["checkout", "-q", "FETCH_HEAD"]):
            r = subprocess.run([*GIT, "-C", str(d), *args], capture_output=True, text=True, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
            if r.returncode:
                fallo(f"repo '{repo['nombre']}' no disponible: no se pudo obtener {repo['url']} en {repo['commit']} ({r.stderr.strip()[:200]}). "
                      "La red solo se usa para clonar; reintente con red o copie el clon en $T2_UPSTREAM/<nombre>.")
    lic = d / repo["license_file"]
    if not lic.exists() or sha256(lic) != repo["license_sha256"]:
        fallo(f"licencia de '{repo['nombre']}': {repo['license_file']} no coincide con el sha256 fijado")
    return d


def clonar(up):
    Path(up).mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(5) as ex:
        list(ex.map(lambda r: clonar_uno(r, up), repos()))
    print(f"clonados {len(repos())} repos en {up}")


# ---------- ejecutar la suite ----------
def entorno(repo):
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTEST_ADDOPTS", "VIRTUAL_ENV")}
    return {**env, **repo["env"]}


def correr(repo, cwd, extra=(), timeout=180):
    t = time.time()
    try:
        r = subprocess.run([*repo["test"], *extra], cwd=cwd, env=entorno(repo), capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr, time.time() - t
    except subprocess.TimeoutExpired:
        return 124, "", time.time() - t


FALLA = re.compile(r"^(?:FAILED|ERROR|SUBFAIL\w*)(?:\([^)]*\))? ([^\s:]+\.py)", re.M)


def exportar(src, dst):
    """Arbol de archivos versionados de src (sin .git) en dst."""
    dst.mkdir(parents=True, exist_ok=True)
    p1 = subprocess.Popen([*GIT, "-C", str(src), "archive", "HEAD"], stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(dst)], stdin=p1.stdout, check=True)
    if p1.wait():
        fallo(f"git archive fallo en {src}")


def aplicar(texto, m, inverso=False):
    a, b = (m["reemplazar"], m["buscar"]) if inverso else (m["buscar"], m["reemplazar"])
    if texto.count(a) != 1:
        raise ValueError(f"'{a[:60]}' aparece {texto.count(a)} veces en {m['archivo']} (debe ser 1)")
    return texto.replace(a, b)


# ---------- calificar ----------
def n_archivos_test(raiz):
    return len([p for p in raiz.rglob("*.py") if re.match(r"(test_.*|.*_test)\.py$", p.name) and ".git" not in p.parts])


def visible_rc(repo, w, m, ocultos):
    """Lo que ve el agente: base mutada sin los tests ocultos. Debe estar en verde para que tenga algo que ejecutar."""
    f = w / m["archivo"]; original = f.read_text()
    movidos = [(w / r, w / (r + ".oculto")) for r in ocultos]
    try:
        f.write_text(aplicar(original, m))
        for a, b in movidos: a.rename(b)
        return correr(repo, w, timeout=120)[0]
    finally:
        for a, b in movidos: b.rename(a)
        f.write_text(original)


def calificar_repo(repo, up):
    nombre = repo["nombre"]
    cands = leer(AQUI / "candidatas" / f"{nombre}.json")
    validas, descartadas = [], []
    with tempfile.TemporaryDirectory(prefix=f"t2-cal-{nombre}-") as tmp:
        w = Path(tmp) / "w"
        exportar(clonar_uno(repo, up), w)
        rc, out, seg = correr(repo, w)
        if rc:
            fallo(f"{nombre}: la suite sin mutar no pasa (rc={rc}):\n{out[-800:]}")
        print(f"{nombre}: suite base ok en {seg:.1f}s, {n_archivos_test(w)} archivos de test", flush=True)
        total = n_archivos_test(w)
        for m in cands:
            def no(motivo):
                descartadas.append({"repo": nombre, **{k: m[k] for k in ("id", "archivo", "buscar", "reemplazar")}, "motivo": motivo})
            if not ID_RE.fullmatch(m["id"]):
                no("id invalido"); continue
            if REVELA.search(m["descripcion"]):
                no("la descripcion nombra tests, archivos o lineas"); continue
            f = w / m["archivo"]
            if "/tests/" in "/" + m["archivo"] or Path(m["archivo"]).name.startswith("test_"):
                no("la mutacion toca un test"); continue
            original = f.read_text()
            try:
                f.write_text(aplicar(original, m))
            except ValueError as e:
                no(str(e)); continue
            try:
                rc, out, seg = correr(repo, w, ["-rfE", "--tb=no"], timeout=120)
            finally:
                f.write_text(original)
            archivos = sorted(set(FALLA.findall(out)))
            if rc == 124:
                no("timeout: la mutacion cuelga la suite")
            elif rc == 0:
                no("indetectable: la suite completa pasa con la mutacion")
            elif re.search(r"^ERROR ", out, re.M):
                no("rompe la coleccion/importacion: trivial")
            elif not archivos:
                no(f"fallo sin archivo atribuible (rc={rc})")
            elif len(archivos) > min(3, max(1, total // 2)):
                no(f"la detectan {len(archivos)} archivos de test ({total} en total): quitarlos dejaria al agente sin suite")
            elif len(validas) >= 10:
                no("sobrante: el repo ya tiene 10 validas")
            elif (rc2 := visible_rc(repo, w, m, archivos)):
                no(f"sin los tests ocultos la suite visible falla (rc={rc2}): otros tests dependen de ellos")
            else:
                validas.append({**{k: m[k] for k in ("id", "archivo", "buscar", "reemplazar", "descripcion")}, "ocultos": archivos})
            print(f"  {m['id']}: {'valida' if validas and validas[-1]['id'] == m['id'] else descartadas[-1]['motivo'][:60]}", flush=True)
    return validas, descartadas


def calificar(up, nombres):
    todos = [r for r in repos() if not nombres or r["nombre"] in nombres]
    with cf.ThreadPoolExecutor(5) as ex:
        res = list(ex.map(lambda r: calificar_repo(r, up), todos))
    if os.environ.get("T2_PROBAR"):  # ensayo: no escribe nada (varios agentes pueden probar a la vez)
        for r, (validas, desc) in zip(todos, res):
            print(f"{r['nombre']}: {len(validas)} validas, {len(desc)} descartadas")
        return
    ruta = AQUI / "descartadas.json"
    previas = [d for d in (leer(ruta) if ruta.exists() else []) if d["repo"] not in {r["nombre"] for r in todos}]
    nuevas = []
    for r, (validas, desc) in zip(todos, res):
        escribir(AQUI / "mutaciones" / f"{r['nombre']}.json", validas)
        nuevas += desc
        print(f"{r['nombre']}: {len(validas)} validas, {len(desc)} descartadas" + ("  <-- FALTAN" if len(validas) < 10 else ""))
    escribir(ruta, sorted(previas + nuevas, key=lambda d: (d["repo"], d["id"])))


# ---------- preparar ----------
def verify_cmd(repo, abs_ocultos):
    env = " ".join(f"{k}={v}" for k, v in sorted(repo["env"].items()))
    inner = f"cp -R {abs_ocultos}/. . && env {env} {' '.join(repo['test'])}"
    if any(re.search(r"[\s'\"\\$`;|&<>(){}]", tok) for tok in [*repo["test"], *(f"{k}={v}" for k, v in repo["env"].items())]):
        fallo(f"comando de tests de {repo['nombre']} con caracteres que el verificador simple no admite")
    return f"bash -c '{inner}'"


def preparar(dest):
    dest = Path(dest)
    if dest.exists() and any(dest.iterdir()):
        fallo(f"el destino '{dest}' ya existe y no esta vacio.")
    dest.mkdir(parents=True, exist_ok=True)
    dest = dest.resolve()
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", str(dest)):
        fallo(f"la ruta de destino '{dest}' solo puede tener A-Z a-z 0-9 _ . / -")
    up = Path(os.environ.get("T2_UPSTREAM") or dest / "upstream")
    tareas = []
    for repo in repos():
        muts = leer(AQUI / "mutaciones" / f"{repo['nombre']}.json")
        if len(muts) != 10:
            fallo(f"{repo['nombre']}: {len(muts)} mutaciones, se esperan 10 (¿falta ejecutar `corpus.py calificar`?)")
        origen = clonar_uno(repo, up)
        for i, m in enumerate(muts):
            tid, tdir, oc = m["id"], dest / "tareas" / m["id"], dest / "ocultos" / m["id"]
            exportar(origen, tdir)
            for rel in m["ocultos"]:
                if not (tdir / rel).is_file():
                    fallo(f"{tid}: el test oculto {rel} no existe en {repo['nombre']}@{repo['commit'][:10]}")
                (oc / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(tdir / rel), str(oc / rel))
            f = tdir / m["archivo"]
            try:
                f.write_text(aplicar(f.read_text(), m))
            except ValueError as e:
                fallo(f"{tid}: {e}")
            env = {**os.environ, "GIT_AUTHOR_NAME": "T2 Cualificacion", "GIT_AUTHOR_EMAIL": "t2@factory.local", "GIT_AUTHOR_DATE": FECHA,
                   "GIT_COMMITTER_NAME": "T2 Cualificacion", "GIT_COMMITTER_EMAIL": "t2@factory.local", "GIT_COMMITTER_DATE": FECHA}
            git(tdir, "-c", "init.defaultBranch=main", "init", "-q")
            git(tdir, "add", "-A", "-f")
            git(tdir, "commit", "-qm", f"base {tid}", env=env)
            tareas.append({"id": tid, "group": repo["nombre"], "repo": str(tdir), "base": git(tdir, "rev-parse", "HEAD"),
                           "description": m["descripcion"], "verify": verify_cmd(repo, oc),
                           "split": "validation" if i >= len(muts) - SPLIT_VALIDACION else "development"})
    escribir(dest / "suite.json", {"tasks": tareas})
    print(f"Suite de {len(tareas)} tareas en {dest}/suite.json (sha256 {sha256(dest / 'suite.json')})")


# ---------- validar ----------
def validar_tarea(t, repo, m, up):
    with tempfile.TemporaryDirectory(prefix="t2-val-") as tmp:
        w = Path(tmp) / "w"
        shutil.copytree(t["repo"], w, symlinks=True)
        argv = shlex.split(t["verify"])
        run = lambda: subprocess.run(argv, cwd=w, env=entorno(repo), capture_output=True, text=True, timeout=240).returncode
        # El agente ve la base sin los ocultos: su suite visible debe estar en verde.
        rc_vis, _, _ = correr(repo, w)
        t0 = time.time(); rc_base = run(); seg = time.time() - t0
        # Referencia = mutacion inversa: el archivo vuelve a su contenido en el commit fijado.
        (w / m["archivo"]).write_text((Path(up) / repo["nombre"] / m["archivo"]).read_text())
        rc_ref = run()
    return {"id": t["id"], "grupo": t["group"], "split": t["split"], "ocultos": m["ocultos"], "visible_rc": rc_vis, "base_rc": rc_base,
            "referencia_rc": rc_ref, "ok": rc_base != 0 and rc_ref == 0, "verify_s": round(seg, 1)}


def validar(dest):
    dest = Path(dest).resolve()
    suite = leer(dest / "suite.json")["tasks"]
    por = {r["nombre"]: r for r in repos()}
    muts = {m["id"]: m for r in por for m in leer(AQUI / "mutaciones" / f"{r}.json")}
    up = Path(os.environ.get("T2_UPSTREAM") or dest / "upstream")
    with cf.ThreadPoolExecutor(4) as ex:
        filas = list(ex.map(lambda t: validar_tarea(t, por[t["group"]], muts[t["id"]], up), suite))
    for f in filas:
        if not f["ok"] or f["visible_rc"]:
            print(f"  {f['id']}: base={f['base_rc']} ref={f['referencia_rc']} visible={f['visible_rc']}")
    out = {"suite_sha256": sha256(dest / "suite.json"), "tareas": len(filas), "validas": sum(f["ok"] for f in filas),
           "visible_en_verde": sum(f["visible_rc"] == 0 for f in filas),
           "repos": {r["nombre"]: {"commit": r["commit"], "licencia": r["license_spdx"]} for r in por.values()}, "filas": filas}
    escribir(AQUI / "validacion.json", out)
    print(f"{out['validas']}/{out['tareas']} tareas: verify falla en la base y pasa con la referencia; visible en verde: {out['visible_en_verde']}")
    sys.exit(0 if out["validas"] == out["tareas"] else 1)


if __name__ == "__main__":
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    if cmd == "clonar" and len(args) == 1: clonar(args[0])
    elif cmd == "calificar" and args: calificar(args[0], set(args[1:]))
    elif cmd == "preparar" and len(args) == 1: preparar(args[0])
    elif cmd == "validar" and len(args) == 1: validar(args[0])
    else: fallo(__doc__)
