import { Store } from '../../../../src/store.ts';
import { calculateMetrics } from '../../../../src/metrics.ts';
import { metricsPage } from '../../../../src/web-metrics.ts';
import { startWeb } from '../../../../src/web.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const bench=process.argv.includes('--bench'), dir=mkdtempSync(join(tmpdir(),'webf3-synthetic-')), s=new Store(join(dir,'fabrica.db'));
for (const slug of ['motor','canal']) s.createWorkstream({slug,goal:'Datos sintéticos para F3',repo:'/synthetic',taskLimit:2000});
const now=Date.now();
s.db.transaction(()=>{for(let i=0;i<(bench?1000:8);i++){
 const c=s.createChange(i%3===0?'canal':'motor',`Prueba sintética ${i+1}: ${['revisión','ejecución','entrega'][i%3]}`,'Sin datos personales');
 const a=s.listActivities({changeId:c.id})[0]!; const begin=now-(1+i%40)*86400000;
 s.db.query('UPDATE changes SET created_at=?,status=? WHERE id=?').run(new Date(begin).toISOString(),['completed','in_progress','in_review','blocked'][i%4],c.id);
 s.db.query("UPDATE activities SET kind='investigation',created_at=? WHERE id=?").run(new Date(begin+3600000).toISOString(),a.id);
 s.db.query('DELETE FROM events WHERE change_id=?').run(c.id);
 for(const [j,message] of ['investigation awaiting spec review','investigation approved','human reply received (question demo); re-queued','change retried (investigation)','change completed'].entries()) if(i%4===0||j<2) s.db.query('INSERT INTO events(workstream_id,change_id,activity_id,severity,message,created_at) VALUES (?,?,?,?,?,?)').run(c.workstreamId,c.id,a.id,'info',message,new Date(begin+(j+2)*3600000).toISOString());
 const path=join(dir,'runs',c.id);mkdirSync(path,{recursive:true});writeFileSync(join(path,`${a.id}.json`),JSON.stringify({attemptCosts:[i%5===0?null:(i+1)*.05],isolation:{adapter:i%2?'claude':'native'}}));
}})();s.close();
if(bench){
 const compute=[],http=[],opened=[];
 for(let i=0;i<5;i++){let t=performance.now();const ro=new Store(join(dir,'fabrica.db'),{readonly:true});opened.push(performance.now()-t);t=performance.now();const m=calculateMetrics(ro,dir,{range:'all'});compute.push(performance.now()-t);ro.close();if(m.count!==1000||m.cost.unknownChanges!==200)throw Error('Fixture incorrecta');}
 const server=startWeb(dir,0);let size=0;for(let i=0;i<5;i++){const t=performance.now();const r=await fetch(`http://127.0.0.1:${server.port}/metricas?range=all`);size=(await r.text()).length;http.push(performance.now()-t);if(r.status!==200)throw Error('HTTP');}server.stop(true);
 console.log(JSON.stringify({changes:1000,activities:1000,events:2750,evidenceFiles:1000,evidenceBytes:readdirSync(join(dir,'runs')).reduce((n,id)=>n+readdirSync(join(dir,'runs',id)).reduce((v,f)=>v+statSync(join(dir,'runs',id,f)).size,0),0),computeMs:compute,openReadonlyMs:opened,httpMs:http,htmlCharacters:size,rssMB:process.memoryUsage().rss/1048576},null,2));rmSync(dir,{recursive:true});
}else{const server=startWeb(dir,0);writeFileSync('/tmp/webf3-manual.json',JSON.stringify({dir,port:server.port}));console.log(`Fixture sintética: ${dir}; puerto ${server.port}`); const close=()=>{server.stop(true);rmSync(dir,{recursive:true});process.exit(0)};process.on('SIGTERM',close);process.on('SIGINT',close);await new Promise(()=>{});}
