import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';
delete process.env.REQUIRE_AUTH;
delete process.env.NODE_ENV;
delete process.env.PUBLIC_ORIGIN;
delete process.env.HOST;
const {server,store}=await import('../server.js');
let base;
before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;});
beforeEach(()=>store.transaction(()=>{for(const table of ['events','tasks','notes','day_notes','history','sessions','users'])store.db.exec(`DELETE FROM ${table}`);}));
after(async()=>{await new Promise(resolve=>server.close(resolve));store.db.close();});
async function request(path,method='GET',body,headers={}){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
test('agenda local abre sem cadastro, sessão ou demonstração',async()=>{
  const page=await(await fetch(base)).text();
  assert.ok(!page.includes('id="auth-dialog"'));assert.ok(!page.includes('Explorar demonstração'));assert.ok(!page.includes('id="logout"'));
  const state=await request('/api/auth/session');assert.equal(state.data.directAgenda,true);assert.equal(state.data.user.id,0);
  assert.equal((await request('/api/tasks')).status,200);
  assert.equal((await request('/api/auth/demo','POST',{})).status,404);
});
test('compromissos, notas, tarefas e desfazer funcionam sem cookie',async()=>{
  const value={title:'Agenda direta',date:'2026-10-19',start:'09:00',end:'10:00',category:'pessoal'};
  const created=await request('/api/events','POST',value);assert.equal(created.status,201);
  assert.equal((await request('/api/events?month=2026-10')).data[0].title,value.title);
  const deleted=await request(`/api/events/${created.data.id}`,'DELETE');assert.equal(deleted.status,200);
  assert.equal((await request(`/api/history/${deleted.data.historyId}/undo`,'POST',{})).status,200);
  assert.equal((await request('/api/tasks','POST',{title:'Tarefa local'})).status,201);
  assert.equal((await request('/api/notes?month=2026-10','PUT',{content:'Anotação local'})).status,200);
  assert.equal((await request('/api/notes?month=2026-10')).data.content,'Anotação local');
});
test('dados da conta pessoal existente são mantidos e cookie de demo é ignorado',async()=>{
  store.db.prepare("INSERT INTO users(id,email,name,password,demo,created_at) VALUES(1,'pessoal@example.test','Pessoal','teste',0,?), (2,'demo@example.test','Demo','',1,?)").run(new Date().toISOString(),new Date().toISOString());
  store.setNote(1,'2026-10','Meus dados existentes');store.setNote(2,'2026-10','Dados fictícios');
  const note=await request('/api/notes?month=2026-10','GET',undefined,{Cookie:'florir_session='+'a'.repeat(64)});
  assert.equal(note.data.content,'Meus dados existentes');
  assert.equal((await request('/api/auth/session')).data.user.id,1);
});
test('acesso direto continua rejeitando origem externa',async()=>{
  assert.equal((await request('/api/tasks','POST',{title:'Bloqueada'},{Origin:'https://outro.example'})).status,403);
  assert.deepEqual((await request('/api/tasks')).data,[]);
});

test('quantidade de ocorrências funciona na criação, edição e no desfazer pela API',async()=>{
  const value={title:'Revisão recorrente',date:'2026-10-20',start:'09:00',end:'10:00',category:'estudos',recurrence:'weekly',repeatCount:3};
  const created=await request('/api/events','POST',value);assert.equal(created.status,201);
  const range='/api/events?from=2026-10-01&to=2026-12-01';
  assert.deepEqual((await request(range)).data.map(e=>e.date),['2026-10-20','2026-10-27','2026-11-03']);
  const edited=await request(`/api/events/${created.data.id}`,'PUT',{...value,repeatCount:1});assert.equal(edited.status,200);
  assert.equal((await request(range)).data.length,1);
  assert.equal((await request(`/api/history/${edited.data.historyId}/undo`,'POST',{})).status,200);
  assert.equal((await request(range)).data.length,3);
  assert.equal((await request('/api/events','POST',{...value,repeatCount:54})).status,400);
  assert.equal((await request(range)).data.length,3);
});
