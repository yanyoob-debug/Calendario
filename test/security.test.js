import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH=':memory:';
process.env.REQUIRE_AUTH='1';
const {server,store}=await import('../server.js');
let base,owner,other,ownerId,otherId;
const sample={title:'Compromisso de teste',description:'Descrição',date:'2029-06-10',start:'09:00',end:'10:00',category:'pessoal',completed:false};
async function request(path,method='GET',body,cookie=owner,headers={}){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie||'',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
function raw(path,headers={},method='GET',body){
  return new Promise((resolve,reject)=>{
    const req=http.request(base,{path,method,headers:{Cookie:owner||'',...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));});
    req.setTimeout(2000,()=>req.destroy(Error('Tempo esgotado')));req.on('error',reject);req.end(body);
  });
}
function slowBody(path,method,body){
  const payload=JSON.stringify(body);
  const observed=new Promise(resolve=>server.once('request',resolve));
  let finish;
  const response=new Promise((resolve,reject)=>{
    const req=http.request(base,{path,method,headers:{Cookie:owner,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));});
    req.setTimeout(2000,()=>req.destroy(Error('Tempo esgotado')));req.on('error',reject);req.write(payload.slice(0,1));finish=()=>req.end(payload.slice(1));
  });
  return {observed,response,finish};
}
before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  store.setNote(0,'2029-06','Anotação legada preservada');
  const first=await request('/api/auth/register','POST',{name:'Proprietário',email:'audit-owner@example.test',password:'senha-teste-12345'},'');
  assert.equal(first.status,200);owner=first.cookie;ownerId=first.data.user.id;
  assert.equal(store.getItem(ownerId,'note','2029-06').content,'Anotação legada preservada');
  const second=await request('/api/auth/register','POST',{name:'Outro usuário',email:'audit-other@example.test',password:'senha-teste-67890'},'');
  other=second.cookie;otherId=second.data.user.id;
});
beforeEach(()=>{store.transaction(()=>{for(const table of ['events','tasks','notes','day_notes','history'])store.db.exec(`DELETE FROM ${table}`);});});
after(async()=>{await new Promise(resolve=>server.close(resolve));store.db.close();});

test('todas as rotas de dados e mutações exigem autenticação',async()=>{
  const cases=[['/api/events?month=2029-06'],['/api/tasks'],['/api/notes?month=2029-06'],['/api/day-notes?month=2029-06'],['/api/history'],['/api/trash'],['/api/calendar/export'],['/api/events','POST',sample],['/api/events/1','PUT',sample],['/api/events/1','DELETE'],['/api/tasks','POST',{title:'Tarefa'}],['/api/tasks/1','PATCH',{completed:true}],['/api/tasks/1','DELETE'],['/api/notes?month=2029-06','PUT',{content:'Texto'}],['/api/day-notes/2029-06-10','PUT',{content:'Texto'}],['/api/history/1/undo','POST',{}],['/api/history/1/version','POST',{}],['/api/trash/event/1/restore','POST',{}],['/api/trash/task/1/restore','POST',{}],['/api/calendar/import','POST',{content:'Inválido'}]];
  for(const [path,method='GET',body]of cases)assert.equal((await request(path,method,body,'')).status,401,`${method} ${path}`);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM history').get().n,0);
});
test('cadastro, edição, conclusão, exclusão, restauração e desfazer nas quatro categorias',async()=>{
  for(const [index,category]of ['pessoal','trabalho','estudos','saude'].entries()){
    const value={...sample,category,date:`2029-06-${11+index}`};
    const created=await request('/api/events','POST',value);assert.equal(created.status,201);
    const id=created.data.id,updated=await request(`/api/events/${id}`,'PUT',{...value,title:'Editado',completed:true});
    assert.equal(updated.data.completed,1);
    const deleted=await request(`/api/events/${id}`,'DELETE');assert.equal(deleted.status,200);
    assert.equal((await request(`/api/events/${id}`,'DELETE')).status,404);
    const restored=await request(`/api/trash/event/${id}/restore`,'POST',{});assert.equal(restored.status,200);
    assert.equal((await request(`/api/trash/event/${id}/restore`,'POST',{})).status,409);
    assert.equal((await request(`/api/history/${restored.data.historyId}/undo`,'POST',{})).status,200);
    assert.ok(store.getItem(ownerId,'event',id).deleted_at);
  }
});
test('outra conta não edita, exclui, restaura ou desfaz itens do proprietário',async()=>{
  const created=await request('/api/events','POST',{...sample,user_id:otherId}),eventId=created.data.id;
  const task=await request('/api/tasks','POST',{title:'Tarefa privada',user_id:otherId});
  const note=await request('/api/notes?month=2029-06','PUT',{content:'Nota privada',user_id:otherId});
  for(const [path,method,body]of [[`/api/events/${eventId}`,'PUT',sample],[`/api/events/${eventId}`,'DELETE'],[`/api/tasks/${task.data.id}`,'PATCH',{completed:true}],[`/api/tasks/${task.data.id}`,'DELETE'],[`/api/history/${note.data.historyId}/version`,'POST',{}]])assert.equal((await request(path,method,body,other)).status,404);
  assert.equal((await request(`/api/history/${created.data.historyId}/undo`,'POST',{},other)).status,409);
  await request(`/api/events/${eventId}`,'DELETE');await request(`/api/tasks/${task.data.id}`,'DELETE');
  assert.equal((await request(`/api/trash/event/${eventId}/restore`,'POST',{},other)).status,404);
  assert.equal((await request(`/api/trash/task/${task.data.id}/restore`,'POST',{},other)).status,404);
  assert.deepEqual((await request('/api/history','GET',undefined,other)).data,[]);
  assert.deepEqual((await request('/api/trash','GET',undefined,other)).data,[]);
  assert.equal((await request('/api/notes?month=2029-06','GET',undefined,other)).data.content,'');
  assert.ok(!(await request('/api/calendar/export','GET',undefined,other)).data.includes('Nota privada'));
});
test('texto com HTML e SQL é armazenado como dado sem alterar o banco',async()=>{
  const title=`<img src=x onerror=alert(1)> '; DROP TABLE users; --`;
  assert.equal((await request('/api/events','POST',{...sample,title})).status,201);
  assert.equal((await request('/api/events?month=2029-06')).data[0].title,title);
  assert.equal((await request('/api/tasks','POST',{title})).status,201);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM users WHERE demo=0').get().n,2);
});
test('notas mensais e diárias aceitam Unicode, excluem, desfazem e restauram versões',async()=>{
  for(const [key,path]of [['2029-06','/api/notes?month=2029-06'],['2029-06-10','/api/day-notes/2029-06-10']]){
    const first=await request(path,'PUT',{content:'Texto com acentos e emoji 📅'});assert.equal(first.status,200);
    const deleted=await request(path,'PUT',{content:''});assert.equal(deleted.status,200);
    assert.equal((await request(`/api/history/${deleted.data.historyId}/undo`,'POST',{})).status,200);
    assert.equal(store.getItem(ownerId,'note',key).content,'Texto com acentos e emoji 📅');
    await request(path,'PUT',{content:'Segunda versão'});
    assert.equal((await request(`/api/history/${first.data.historyId}/version`,'POST',{})).status,200);
    assert.equal(store.getItem(ownerId,'note',key).content,'Texto com acentos e emoji 📅');
    assert.equal((await request(path,'PUT',{content:'📅'.repeat(5000)})).status,200);
    assert.equal((await request(path,'PUT',{content:'a'.repeat(10001)})).status,400);
  }
});
test('histórico pagina sem repetir registros e rejeita páginas inválidas',async()=>{
  for(let i=0;i<35;i++)assert.equal((await request('/api/tasks','POST',{title:`Tarefa ${i}`})).status,201);
  const first=(await request('/api/history')).data,second=(await request('/api/history?offset=30')).data;
  assert.equal(first.length,30);assert.equal(second.length,5);assert.equal(new Set([...first,...second].map(item=>item.id)).size,35);
  for(const offset of ['-1','0.5','Infinity','abc','9007199254740992'])assert.equal((await request(`/api/history?offset=${offset}`)).status,400);
});
test('alterações simultâneas de mesmo horário não contornam o detector de conflitos',async()=>{
  const results=await Promise.all([request('/api/events','POST',sample),request('/api/events','POST',{...sample,title:'Concorrente'})]);
  assert.deepEqual(results.map(result=>result.status).sort(),[201,409]);
  assert.equal((await request('/api/events?month=2029-06')).data.length,1);
});
test('ICS com conflitos internos é recusado atomicamente',async()=>{
  const content='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:20290610T090000\r\nDTEND:20290610T100000\r\nSUMMARY:Primeiro\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20290610T093000\r\nDTEND:20290610T103000\r\nSUMMARY:Segundo\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const blocked=await request('/api/calendar/import','POST',{content});assert.equal(blocked.status,409);
  assert.deepEqual((await request('/api/events?month=2029-06')).data,[]);
  assert.equal((await request('/api/calendar/import','POST',{content,allowConflict:true})).data.imported,2);
});
test('autenticação simultânea com mesmo e-mail retorna conflito sem erro interno',async()=>{
  const value={name:'Concorrente',email:'duplicate@example.test',password:'senha-concorrente-123'};
  const results=await Promise.all([request('/api/auth/register','POST',value,''),request('/api/auth/register','POST',value,'')]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
});
test('host externo é bloqueado mesmo que a origem combine com ele',async()=>{
  const result=await raw('/api/tasks',{Host:'site-externo.example',Origin:'http://site-externo.example'});
  assert.equal(result.status,403);
});
test('corpo JSON disfarçado de texto simples é rejeitado',async()=>{
  const result=await raw('/api/tasks',{'Content-Type':'text/plain'},'POST',JSON.stringify({title:'Não deve ser criado'}));
  assert.equal(result.status,415);assert.equal((await request('/api/tasks')).data.length,0);
});
test('JSON inválido e corpos excessivos não gravam dados',async()=>{
  for(const value of ['{','null','[]','42','"texto"']){
    const response=await raw('/api/tasks',{'Content-Type':'application/json'},'POST',value);assert.equal(response.status,400);
  }
  assert.equal((await request('/api/tasks','POST',{title:'a'.repeat(650001)})).status,413);
  assert.equal((await request('/api/tasks')).data.length,0);
});
test('sessões expiradas e cookies falsos não acessam a API',async()=>{
  assert.equal((await request('/api/tasks','GET',undefined,'florir_session='+'a'.repeat(64))).status,401);
  store.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(ownerId);
  try{assert.equal((await request('/api/tasks')).status,401);}
  finally{store.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(Date.now()+3600000,ownerId);}
});
test('arquivos privados, caminhos codificados e travessia não são servidos',async()=>{
  for(const path of ['/data/agenda.sqlite','/lib/auth.js','/.env','/.git/config','/%2e%2e/server.js','/..%2fserver.js','/docs/deployment.md'])assert.equal((await raw(path)).status,404,path);
});
test('edições com corpo atrasado não modificam itens já excluídos',async()=>{
  const created=await request('/api/events','POST',sample),pending=slowBody(`/api/events/${created.data.id}`,'PUT',{...sample,title:'Edição atrasada'});
  await pending.observed;await request(`/api/events/${created.data.id}`,'DELETE');pending.finish();
  assert.equal((await pending.response).status,404);
  assert.equal(store.getItem(ownerId,'event',created.data.id).title,sample.title);
  const task=await request('/api/tasks','POST',{title:'Tarefa'}),patch=slowBody(`/api/tasks/${task.data.id}`,'PATCH',{completed:true});
  await patch.observed;await request(`/api/tasks/${task.data.id}`,'DELETE');patch.finish();assert.equal((await patch.response).status,404);
  assert.equal(store.getItem(ownerId,'task',task.data.id).completed,0);
});
test('restaurações simultâneas não registram recuperação duplicada',async()=>{
  const task=await request('/api/tasks','POST',{title:'Tarefa'});await request(`/api/tasks/${task.data.id}`,'DELETE');
  const path=`/api/trash/task/${task.data.id}/restore`,pending=slowBody(path,'POST',{});
  await pending.observed;assert.equal((await request(path,'POST',{})).status,200);pending.finish();
  assert.equal((await pending.response).status,409);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM history WHERE action='restore'").get().n,1);
});
test('URL malformada não derruba o servidor',async()=>{
  assert.equal((await raw('http://[')).status,400);
  assert.equal((await request('/api/tasks')).status,200);
});
test('cookies de sessão têm proteção e tokens não são guardados em texto puro',async()=>{
  const login=await request('/api/auth/login','POST',{email:'audit-owner@example.test',password:'senha-teste-12345'},'');
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Path=\//);
  const token=login.cookie.split('=')[1];assert.ok(!store.db.prepare('SELECT token FROM sessions').all().some(row=>row.token===token));
  await request('/api/auth/logout','POST',{},login.cookie);
  assert.equal((await request('/api/history','GET',undefined,login.cookie)).status,401);
});
test('validações rejeitam tipos, limites e datas inválidas sem gerar histórico',async()=>{
  for(const patch of [{title:''},{title:'a'.repeat(121)},{description:'a'.repeat(3001)},{date:'2029-02-29'},{date:'2029-13-01'},{start:['09:00']},{end:{value:'10:00'}},{start:'24:00'},{start:'10:00',end:'09:00'},{completed:1},{recurrence:'yearly'},{recurrence:'weekly',until:'2029-06-09'}])assert.equal((await request('/api/events','POST',{...sample,...patch})).status,400);
  for(const path of ['/api/events/9007199254740992','/api/tasks/0','/api/history/999999999999999999999/undo'])assert.equal((await request(path,'DELETE')).status,400);
  for(const title of [null,42,{},[],true,'a'.repeat(201)])assert.equal((await request('/api/tasks','POST',{title})).status,400);
  for(const path of ['/api/events?from=2029-01-01&to=2029-12-31','/api/events?from=2029-06-10&to=2029-06-01','/api/events?month=2029-00','/api/notes?month=no','/api/day-notes?month=2029-13'])assert.equal((await request(path)).status,400);
  assert.equal((await request('/api/history')).data.length,0);
});
test('limite de login bloqueia tentativas repetidas e ignora IP informado pelo cliente',async()=>{
  let last;
  for(let i=0;i<22;i++)last=await request('/api/auth/login','POST',{email:'audit-owner@example.test',password:'senha-errada-12345'},'',{'X-Forwarded-For':`192.0.2.${i}`});
  assert.equal(last.status,429);assert.equal((await request('/api/tasks')).status,200);
});
