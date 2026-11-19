import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
const root = process.argv[2]!;
const {Store} = await import(`${root}/src/store.ts`);
const {startWeb} = await import(`${root}/src/web.ts`);
const dir = mkdtempSync('/tmp/fabf2-body-');
const store = new Store(`${dir}/fabrica.db`);
const ws = store.createWorkstream({slug:'probe',repo:'/repo',goal:'g'});
const c = store.createChange(ws.id,'probe','d');
const a = store.listActivities({changeId:c.id})[0];
store.db.query("UPDATE activities SET kind='change_review',status='completed',review_status='awaiting' WHERE id=?").run(a.id);
const web = startWeb(dir,0,{write:true});
try {
 const login = await fetch(web.loginUrl,{redirect:'manual'});
 const cookie = login.headers.get('set-cookie')!.split(';')[0];
 const code = await new Promise<number>((resolve,reject)=>{
  const socket = createConnection({host:'127.0.0.1',port:web.port},()=>{
   const chunk='padding='+'a'.repeat(17000);
   socket.write(`POST /activities/${a.id}/review HTTP/1.1\r\nHost: 127.0.0.1:${web.port}\r\nOrigin: http://127.0.0.1:${web.port}\r\nCookie: ${cookie}\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
   // No se termina el cuerpo: el límite nativo debe responder antes de leerlo entero.
  });
  const timer=setTimeout(()=>{socket.destroy();reject(new Error('No hubo rechazo antes del final del cuerpo'));},5000);
  socket.once('data',data=>{clearTimeout(timer);socket.destroy();resolve(Number(/^HTTP\/1.1 (\d+)/.exec(data.toString())?.[1]));});
  socket.once('error',err=>{clearTimeout(timer);socket.destroy();reject(err)});
 });
 if(code!==413)throw new Error(`Esperado 413, recibido ${code}`);
 console.log('PASS: 413 antes del final del cuerpo');
} finally {web.stop(true);store.close();rmSync(dir,{recursive:true,force:true})}
