import pathlib, tempfile, subprocess, shutil, json
root=pathlib.Path.cwd(); dest=pathlib.Path(tempfile.mkdtemp(prefix='webf3-mutation-'))
subprocess.run(['git','archive','HEAD'],stdout=open(dest/'repo.tar','wb'),check=True)
subprocess.run(['tar','xf',str(dest/'repo.tar'),'-C',str(dest)],check=True)
(dest/'node_modules').symlink_to((root/'node_modules').resolve(),target_is_directory=True)
mutations=[('mediana','src/metrics.ts','(sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2','sorted[0]!'),('null-cero','src/metrics.ts','total: unknownChanges ? null : measured','total: measured'),('fecha','src/store.ts','julianday(created_at) >= julianday(?)','julianday(?) IS NOT NULL'),('workstream','src/store.ts','(? IS NULL OR workstream_id = ?)','(? IS NULL OR workstream_id = ? OR 1=1)')]
results=[]
for name,path,old,new in mutations:
 p=dest/path; content=p.read_text(); assert old in content
 p.write_text(content.replace(old,new,1))
 r=subprocess.run(['bun','test','tests/web-metrics.test.ts'],cwd=dest,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 (pathlib.Path('/tmp')/f'webf3-mut-{name}.log').write_text(r.stdout)
 results.append({'mutation':name,'exit':r.returncode,'killed':r.returncode!=0,'failure':[line for line in r.stdout.splitlines() if '(fail)' in line]})
 p.write_text(content)
r=subprocess.run(['bun','test','tests/web-metrics.test.ts'],cwd=dest,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
pathlib.Path('/tmp/webf3-mut-restored.log').write_text(r.stdout)
print(json.dumps({'copy':str(dest),'results':results,'restoredExit':r.returncode},indent=2)); assert all(x['killed'] for x in results) and r.returncode==0
shutil.rmtree(dest)
