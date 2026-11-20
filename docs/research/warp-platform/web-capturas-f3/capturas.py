import subprocess,json,pathlib
out=pathlib.Path('docs/research/warp-platform/web-capturas-f3');out.mkdir(parents=True,exist_ok=True)
x=json.load(open('/tmp/webf3-manual.json'));url=f'http://127.0.0.1:{x["port"]}/metricas?range=all'
def ab(*args):
 r=subprocess.run(['agent-browser','--session','fabf3',*args],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);assert r.returncode==0,r.stdout;return r.stdout
records=[]
for width,height in [(1440,1000),(390,844)]:
 ab('set','viewport',str(width),str(height))
 for theme in ['light','dark']:
  ab('set','media',theme);ab('open',url)
  rec=ab('eval',"JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light',scripts:document.scripts.length,colors:{text:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor},tables:document.querySelectorAll('table').length,svg:document.querySelectorAll('svg').length})")
  ab('screenshot','--full',str(out/f'metricas-{width}-{theme}.png'))
  records.append({'width':width,'theme':theme,'dom':json.loads(json.loads(rec)),'console':ab('console'),'errors':ab('errors')})
ab('select','select[name=ws]','motor');ab('select','select[name=range]','7');ab('click','button[type=submit]');ab('wait','--url','**/metricas?ws=motor&range=7');records.append({'filterURL':ab('get','url'),'filtered':ab('get','text','main')})
(out/'recorrido.json').write_text(json.dumps(records,ensure_ascii=False,indent=2));print(json.dumps(records,ensure_ascii=False,indent=2))
