import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openStore } from './lib/store.js';
import { authStore, hashPassword, verifyPassword } from './lib/auth.js';
import { validateEvent, validDate, occurrences, findConflicts, exportICS, parseICS, addDays } from './lib/calendar.js';
import { matchesSearch } from './public/search.js';

const root=dirname(fileURLToPath(import.meta.url));
if(process.env.NODE_ENV==='production' && !process.env.PUBLIC_ORIGIN)throw Error('Configure PUBLIC_ORIGIN com a origem HTTPS do site.');
const publicOrigin=process.env.PUBLIC_ORIGIN?new URL(process.env.PUBLIC_ORIGIN):null;
if(publicOrigin && (publicOrigin.origin!==process.env.PUBLIC_ORIGIN || (process.env.NODE_ENV==='production' && publicOrigin.protocol!=='https:')))throw Error('PUBLIC_ORIGIN deve ser uma origem válida, sem caminho ou barra final, e HTTPS em produção.');
export const store=openStore(process.env.DB_PATH||join(root,'data','agenda.sqlite'));
const {db,transaction,record,getItem,setNote,undo}=store;
const auth=authStore(db), limits=new Map();
// Personal use opens the original local agenda directly, ignoring old demo cookies.
const directAgenda=process.env.REQUIRE_AUTH!=='1' && process.env.NODE_ENV!=='production' && !publicOrigin && (!process.env.HOST||['127.0.0.1','localhost','::1'].includes(process.env.HOST));
const localAccount=()=>db.prepare('SELECT id,name,email,demo FROM users WHERE demo=0 ORDER BY id LIMIT 1').get()||{id:0,name:'Minha agenda',demo:0};
const fail=(status,message,extra={})=>Object.assign(Error(message),{status,...extra});
function throttle(req,kind,max) {
  const now=Date.now(),key=`${req.socket.remoteAddress}:${kind}`;
  for(const [key,value]of limits)if(value.until<now)limits.delete(key);
  const item=limits.get(key)||{until:now+15*60000,count:0};
  item.count++;limits.set(key,item);
  if(item.count>max)throw fail(429,'Muitas tentativas. Aguarde 15 minutos.');
}
async function body(req) {
  if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||''))throw fail(415,'Envie o conteúdo como application/json.');
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>650000)throw fail(413,'Conteúdo muito grande.');}
  try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw fail(400,'JSON inválido.');}
}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function monthRange(month){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))throw fail(400,'Mês inválido.');
  const from=month+'-01',date=new Date(`${from}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth()+1);date.setUTCDate(0);
  return [from,date.toISOString().slice(0,10)];
}
function eventRows(user,from,to){return db.prepare('SELECT * FROM events WHERE user_id=? AND deleted_at IS NULL AND date<=? AND (date>=? OR "until">=?)').all(user,to,from,from);}
function checkConflicts(user,value,id,allow){
  if(allow===true)return;
  const conflicts=findConflicts({...value,id},eventRows(user,value.date,value.until||value.date));
  if(conflicts.length)throw fail(409,'Este horário coincide com outro compromisso.',{conflicts});
}
function createEvent(user,value){
  const fields=Object.keys(value);
  const result=db.prepare(`INSERT INTO events(user_id,${fields.map(key=>`"${key}"`).join(',')}) VALUES(?,${fields.map(()=>'?').join(',')})`).run(user,...fields.map(key=>value[key]));
  const item=getItem(user,'event',result.lastInsertRowid);
  return {...item,historyId:record(user,'event',item.id,'create',null,item,item.title)};
}
function changeNote(user,key,content,action='update'){
  const before=getItem(user,'note',key);
  if((before?.content||'')===content)return {ok:true};
  setNote(user,key,key.length===10&&content===''?null:content);
  return {ok:true,historyId:record(user,'note',key,action,before,getItem(user,'note',key),`Anotações de ${key.split('-').reverse().join('/')}`)};
}
function requireItem(user,entity,id,deleted=false){const item=getItem(user,entity,id);if(!item||(!deleted&&item.deleted_at))throw fail(404,'Item não encontrado.');return item;}
function seedDemo(user){
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  transaction(()=>{
    for(const item of [
      {title:'Planejamento da semana',date,start:'09:00',end:'09:30',category:'trabalho',recurrence:'weekly',until:addDays(date,28)},
      {title:'Estudar JavaScript',date:addDays(date,1),start:'14:00',end:'15:30',category:'estudos'},
      {title:'Consulta de rotina',date:addDays(date,2),start:'10:00',end:'11:00',category:'saude'},
      {title:'Organizar documentos',date:addDays(date,4),start:'16:00',end:'16:30',category:'pessoal'}
    ])createEvent(user,validateEvent(item));
    for(const title of ['Revisar o currículo','Preparar a apresentação do projeto','Responder mensagens']){
      const result=db.prepare('INSERT INTO tasks(user_id,title) VALUES(?,?)').run(user,title);
      const item=getItem(user,'task',result.lastInsertRowid);record(user,'task',item.id,'create',null,item,title);
    }
    changeNote(user,date.slice(0,7),'Demonstração: explore as visões, edite compromissos e use o histórico para desfazer alterações.');
    changeNote(user,date,'Revisar os compromissos e registrar os pontos da reunião.');
  });
}

export const server=http.createServer(async(req,res)=>{
  const started=performance.now();
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  try{
    let host;
    try{host=new URL(`http://${req.headers.host}`);if(host.username||host.password||host.pathname!=='/'||host.search||host.hash)throw Error();}catch{throw fail(400,'Endereço da requisição inválido.');}
    const localHost=['localhost','127.0.0.1','[::1]'].includes(host.hostname) && Number(host.port||80)===req.socket.localPort;
    if(!localHost && (!publicOrigin || host.host!==publicOrigin.host))throw fail(403,'Endereço da requisição não autorizado.');
    if(!req.url?.startsWith('/')||req.url.startsWith('//'))throw fail(400,'URL inválida.');
    let url;try{url=new URL(req.url,'http://localhost');}catch{throw fail(400,'URL inválida.');}
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==(process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`))throw fail(403,'Origem não autorizada.');
    if(directAgenda && url.pathname.startsWith('/api/auth/') && url.pathname!=='/api/auth/session')throw fail(404,'Rota não disponível na agenda pessoal.');
    if(url.pathname==='/api/auth/session'&&req.method==='GET'){
      if(directAgenda)return send(res,200,{user:localAccount(),directAgenda:true,setupRequired:false,setupTokenRequired:false});
      const setupRequired=!db.prepare('SELECT id FROM users WHERE demo=0 LIMIT 1').get();
      return send(res,200,{user:auth.session(req),setupRequired,setupTokenRequired:setupRequired&&process.env.NODE_ENV==='production'});
    }
    if(['/api/auth/register','/api/auth/login'].includes(url.pathname)&&req.method==='POST'){
      throttle(req,'auth',20);
      const input=await body(req),email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof input.password!=='string'||input.password.length<10||input.password.length>128)throw fail(400,'Informe um e-mail válido e uma senha de 10 a 128 caracteres.');
      let user;
      if(url.pathname.endsWith('/register')){
        if(typeof input.name!=='string'||!input.name.trim()||input.name.length>60)throw fail(400,'Informe seu nome (até 60 caracteres).');
        const first=!db.prepare('SELECT id FROM users WHERE demo=0 LIMIT 1').get();
        if(first&&process.env.NODE_ENV==='production'&&(!process.env.SETUP_TOKEN||input.setupToken!==process.env.SETUP_TOKEN))throw fail(403,'Para criar a primeira conta, informe o código de configuração do servidor.');
        if(db.prepare('SELECT id FROM users WHERE email=?').get(email))throw fail(409,'Não foi possível criar a conta com este e-mail.');
        const password=await hashPassword(input.password);
        user=transaction(()=>{
          if(db.prepare('SELECT id FROM users WHERE email=?').get(email))throw fail(409,'Não foi possível criar a conta com este e-mail.');
          const claim=!db.prepare('SELECT id FROM users WHERE demo=0 LIMIT 1').get();
          const result=db.prepare('INSERT INTO users(email,name,password,created_at) VALUES(?,?,?,?)').run(email,input.name.trim(),password,new Date().toISOString());
          const id=Number(result.lastInsertRowid);
          if(claim)for(const table of ['events','tasks','notes','day_notes','history'])db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id=0`).run(id);
          return db.prepare('SELECT id,name,email,demo FROM users WHERE id=?').get(id);
        });
      }else{
        const found=db.prepare('SELECT * FROM users WHERE email=? AND demo=0').get(email);
        if(!await verifyPassword(input.password,found?.password||'invalid:'))throw fail(401,'E-mail ou senha incorretos.');
        user={id:found.id,name:found.name,email:found.email,demo:0};
      }
      auth.issue(res,user.id);return send(res,200,{user});
    }
    if(url.pathname==='/api/auth/demo'&&req.method==='POST'){
      throttle(req,'demo',10);
      const cutoff=new Date(Date.now()-86400000).toISOString();
      transaction(()=>{for(const user of db.prepare('SELECT id FROM users WHERE demo=1 AND created_at<?').all(cutoff)){for(const table of ['events','tasks','notes','day_notes','history'])db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);db.prepare('DELETE FROM users WHERE id=?').run(user.id);}db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());});
      const result=db.prepare('INSERT INTO users(email,name,password,demo,created_at) VALUES(?,?,?,1,?)').run(`${randomBytes(12).toString('hex')}@demo.invalid`,'Visitante','',new Date().toISOString());
      const id=Number(result.lastInsertRowid);seedDemo(id);auth.issue(res,id);return send(res,200,{user:{id,name:'Visitante',demo:1}});
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){auth.logout(req,res);return send(res,200,{ok:true});}
    if(url.pathname.startsWith('/api/')){
      const account=directAgenda?localAccount():auth.session(req);if(!account)throw fail(401,'Entre na sua conta para acessar a agenda.');
      const user=account.id;
      if(url.pathname.split('/').some(part=>/^\d+$/.test(part)&&(!Number.isSafeInteger(Number(part))||Number(part)<1)))throw fail(400,'Identificador inválido.');
      if(url.pathname==='/api/events/search'&&req.method==='GET'){
        const query=(url.searchParams.get('q')||'').trim(),reference=url.searchParams.get('date')||new Date().toISOString().slice(0,10);
        if(query.length>200||!validDate(reference))throw fail(400,'Busca inválida.');
        if(!query)return send(res,200,[]);
        const results=db.prepare('SELECT * FROM events WHERE user_id=? AND deleted_at IS NULL').all(user)
          .filter(event=>matchesSearch(event,query)).map(event=>{
            const dates=occurrences(event,event.date,event.until||event.date);
            return dates.find(item=>item.date>=reference)||dates.at(-1);
          }).filter(Boolean).sort((a,b)=>{
            const aPast=a.date<reference,bPast=b.date<reference;
            return Number(aPast)-Number(bPast)||(aPast?b.date.localeCompare(a.date):a.date.localeCompare(b.date))||a.start.localeCompare(b.start)||a.id-b.id;
          });
        return send(res,200,results.slice(0,30));
      }
      if(url.pathname==='/api/events'&&req.method==='GET'){
        const [from,to]=url.searchParams.has('month')?monthRange(url.searchParams.get('month')):[url.searchParams.get('from'),url.searchParams.get('to')];
        if(!validDate(from)||!validDate(to)||to<from||to>addDays(from,62))throw fail(400,'Consulte um período de até 62 dias.');
        const result=eventRows(user,from,to).flatMap(item=>occurrences(item,from,to)).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
        res.setHeader('Server-Timing',`api;dur=${(performance.now()-started).toFixed(2)}`);return send(res,200,result);
      }
      if(url.pathname==='/api/events'&&req.method==='POST'){
        const input=await body(req),value=validateEvent(input);checkConflicts(user,value,null,input.allowConflict);
        return send(res,201,transaction(()=>createEvent(user,value)));
      }
      const event=url.pathname.match(/^\/api\/events\/(\d+)$/);
      if(event&&['PUT','DELETE'].includes(req.method)){
        const input=req.method==='PUT'?await body(req):null;
        const before=requireItem(user,'event',event[1]);
        if(req.method==='DELETE')return send(res,200,transaction(()=>{db.prepare('UPDATE events SET deleted_at=? WHERE user_id=? AND id=?').run(new Date().toISOString(),user,before.id);return {ok:true,historyId:record(user,'event',before.id,'delete',before,getItem(user,'event',before.id),before.title)};}));
        const value=validateEvent(input);checkConflicts(user,value,before.id,input.allowConflict);
        return send(res,200,transaction(()=>{
          const fields=Object.keys(value);db.prepare(`UPDATE events SET ${fields.map(key=>`"${key}"=?`).join(',')} WHERE user_id=? AND id=?`).run(...fields.map(key=>value[key]),user,before.id);
          const after=getItem(user,'event',before.id);return {...after,historyId:record(user,'event',before.id,'update',before,after,after.title)};
        }));
      }
      if(url.pathname==='/api/tasks'&&req.method==='GET')return send(res,200,db.prepare('SELECT * FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC').all(user));
      if(url.pathname==='/api/tasks'&&req.method==='POST'){
        const {title}=await body(req);if(typeof title!=='string'||!title.trim()||title.length>200)throw fail(400,'Informe uma tarefa de até 200 caracteres.');
        return send(res,201,transaction(()=>{const result=db.prepare('INSERT INTO tasks(user_id,title) VALUES(?,?)').run(user,title.trim());const item=getItem(user,'task',result.lastInsertRowid);return {...item,historyId:record(user,'task',item.id,'create',null,item,item.title)};}));
      }
      const task=url.pathname.match(/^\/api\/tasks\/(\d+)$/);
      if(task&&['PATCH','DELETE'].includes(req.method)){
        const input=req.method==='PATCH'?await body(req):{},before=requireItem(user,'task',task[1]);
        if(req.method==='PATCH'&&typeof input.completed!=='boolean')throw fail(400,'Estado inválido.');
        return send(res,200,transaction(()=>{
          if(req.method==='DELETE')db.prepare('UPDATE tasks SET deleted_at=? WHERE id=? AND user_id=?').run(new Date().toISOString(),before.id,user);
          else db.prepare('UPDATE tasks SET completed=? WHERE id=? AND user_id=?').run(Number(input.completed),before.id,user);
          return {ok:true,historyId:record(user,'task',before.id,req.method==='DELETE'?'delete':'update',before,getItem(user,'task',before.id),before.title)};
        }));
      }
      const dayNote=url.pathname.match(/^\/api\/day-notes\/(\d{4}-\d{2}-\d{2})$/);
      if(url.pathname==='/api/day-notes'&&req.method==='GET'){
        const [from,to]=monthRange(url.searchParams.get('month'));return send(res,200,db.prepare('SELECT date,content FROM day_notes WHERE user_id=? AND date BETWEEN ? AND ?').all(user,from,to));
      }
      if((url.pathname==='/api/notes'&&['GET','PUT'].includes(req.method))||(dayNote&&req.method==='PUT')){
        const key=dayNote?dayNote[1]:url.searchParams.get('month');
        if(dayNote){if(!validDate(key))throw fail(400,'Data inválida.');}else monthRange(key);
        if(req.method==='GET')return send(res,200,getItem(user,'note',key)||{content:''});
        const {content}=await body(req);if(typeof content!=='string'||content.length>10000)throw fail(400,'Use até 10.000 caracteres nas anotações.');
        return send(res,200,transaction(()=>changeNote(user,key,content)));
      }
      if(url.pathname==='/api/history'&&req.method==='GET'){
        const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)throw fail(400,'Página inválida.');
        const key=url.searchParams.get('note');
        const rows=url.searchParams.get('undoable')==='1'?db.prepare('SELECT * FROM history WHERE user_id=? AND undone=0 AND reversible=1 ORDER BY id DESC LIMIT 1').all(user):key?db.prepare("SELECT * FROM history WHERE user_id=? AND entity='note' AND entity_id=? ORDER BY id DESC LIMIT 30 OFFSET ?").all(user,key,offset):db.prepare('SELECT * FROM history WHERE user_id=? ORDER BY id DESC LIMIT 30 OFFSET ?').all(user,offset);
        return send(res,200,rows.map(row=>({...row,before:JSON.parse(row.before_json||'null'),after:JSON.parse(row.after_json||'null'),before_json:undefined,after_json:undefined})));
      }
      const undoRoute=url.pathname.match(/^\/api\/history\/(\d+)\/undo$/);
      if(undoRoute&&req.method==='POST'){
        const input=await body(req),item=db.prepare('SELECT * FROM history WHERE id=? AND user_id=?').get(Number(undoRoute[1]),user);
        const before=item?JSON.parse(item.before_json||'null'):null;
        if(item?.entity==='event'&&before&&!before.deleted_at)checkConflicts(user,before,before.id,input.allowConflict);
        try{return send(res,200,undo(user,Number(undoRoute[1])));}catch(error){throw fail(409,error.message);}
      }
      const version=url.pathname.match(/^\/api\/history\/(\d+)\/version$/);
      if(version&&req.method==='POST'){
        const item=db.prepare("SELECT * FROM history WHERE id=? AND user_id=? AND entity='note'").get(Number(version[1]),user);if(!item)throw fail(404,'Versão não encontrada.');
        return send(res,200,transaction(()=>changeNote(user,item.entity_id,JSON.parse(item.after_json||'null')?.content||'','restore')));
      }
      if(url.pathname==='/api/trash'&&req.method==='GET')return send(res,200,[...db.prepare("SELECT id,title,deleted_at,'event' AS entity FROM events WHERE user_id=? AND deleted_at IS NOT NULL").all(user),...db.prepare("SELECT id,title,deleted_at,'task' AS entity FROM tasks WHERE user_id=? AND deleted_at IS NOT NULL").all(user)].sort((a,b)=>b.deleted_at.localeCompare(a.deleted_at)));
      const restore=url.pathname.match(/^\/api\/trash\/(event|task)\/(\d+)\/restore$/);
      if(restore&&req.method==='POST'){
        const input=await body(req),before=requireItem(user,restore[1],restore[2],true);if(!before.deleted_at)throw fail(409,'Este item já está ativo.');
        if(restore[1]==='event')checkConflicts(user,{...before,deleted_at:null},before.id,input.allowConflict);
        return send(res,200,transaction(()=>{db.prepare(`UPDATE ${restore[1]==='event'?'events':'tasks'} SET deleted_at=NULL WHERE id=? AND user_id=?`).run(before.id,user);return {ok:true,historyId:record(user,restore[1],before.id,'restore',before,getItem(user,restore[1],before.id),before.title)};}));
      }
      if(url.pathname==='/api/calendar/export'&&req.method==='GET'){
        const items=db.prepare('SELECT * FROM events WHERE user_id=? AND deleted_at IS NULL ORDER BY date,start').all(user);
        res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename="florir.ics"','Cache-Control':'no-store'});return res.end(exportICS(items));
      }
      if(url.pathname==='/api/calendar/import'&&req.method==='POST'){
        const input=await body(req),items=parseICS(input.content),existing=db.prepare('SELECT * FROM events WHERE user_id=? AND deleted_at IS NULL').all(user),unique=[];
        const duplicate=(a,b)=>['title','description','date','start','end','category','recurrence','until'].every(key=>a[key]===b[key]);const conflicts=[];
        for(const item of items){if([...existing,...unique].some(other=>duplicate(item,other)))continue;conflicts.push(...findConflicts(item,[...existing,...unique]));unique.push(item);}
        if(conflicts.length&&input.allowConflict!==true)throw fail(409,'A importação contém conflitos de horário.',{conflicts:conflicts.slice(0,10)});
        return send(res,201,transaction(()=>{unique.forEach(item=>createEvent(user,item));return {imported:unique.length,skipped:items.length-unique.length};}));
      }
      throw fail(404,'Rota não encontrada.');
    }
    const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/search.js':['search.js','text/javascript'],'/style.css':['style.css','text/css']},file=files[url.pathname];
    if(!file||!['GET','HEAD'].includes(req.method))throw fail(404,'Página não encontrada.');
    res.writeHead(200,{'Content-Type':`${file[1]}; charset=utf-8`,'Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"});
    res.end(req.method==='HEAD'?undefined:readFileSync(join(root,'public',file[0])));
  }catch(error){
    if(!error.status&&!/^SQLITE_|database|UNIQUE constraint/i.test(error.message))return send(res,400,{error:error.message});
    send(res,error.status||500,{error:error.status?error.message:'Não foi possível concluir a operação.',...(error.conflicts?{conflicts:error.conflicts}:{})});
  }
});
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`Agenda Florir: http://localhost:${process.env.PORT||3000}`));
