import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.REQUIRE_AUTH = '1';
const { server, store } = await import('../server.js');
let base, sessionCookie='';
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  const result=await request('/api/auth/register','POST',{name:'Teste',email:'owner@example.test',password:'senha-segura-123'});
  assert.equal(result.status,200);sessionCookie=result.cookie;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
async function request(path, method = 'GET', body, cookie = sessionCookie) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type':'application/json',Cookie:cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0] };
}
const event = { title:'Revisar matéria',description:'Capítulo 3',date:'2026-10-19',start:'14:00',end:'15:00',category:'estudos',completed:false };

test('busca global oferece data da próxima ocorrência e preserva isolamento e exclusões',async()=>{
  const item=await request('/api/events','POST',{...event,title:'Preparação do trabalho escolar',description:'Referências para apresentação',date:'2029-10-31',recurrence:'weekly',repeatCount:3});
  assert.equal(item.status,201);
  const path='/api/events/search?q=ESCOL%20preparacao&date=2029-11-01';
  const found=await request(path);
  assert.equal(found.status,200);assert.equal(found.data.length,1);
  assert.equal(found.data[0].date,'2029-11-07');assert.equal(found.data[0].series_date,'2029-10-31');
  assert.equal((await request('/api/events/search?q=referencias&date=2029-12-01')).data[0].date,'2029-11-14');
  assert.equal((await request(path,'GET',undefined,'')).status,401);
  const other=await request('/api/auth/register','POST',{name:'Busca isolada',email:'search@example.test',password:'senha-segura-123'});
  assert.deepEqual((await request(path,'GET',undefined,other.cookie)).data,[]);
  assert.equal((await request('/api/events/search?q=teste&date=invalida')).status,400);
  assert.deepEqual((await request('/api/events/search?q=')).data,[]);
  await request(`/api/events/${item.data.id}`,'DELETE');
  assert.deepEqual((await request(path)).data,[]);
});

test('CRUD de compromissos, filtro mensal e dados persistentes entre requisições', async () => {
  const created = await request('/api/events', 'POST', event);
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request('/api/events?month=2026-10')).data[0].title, event.title);
  assert.deepEqual((await request('/api/events?month=2026-11')).data, []);
  const updated = await request(`/api/events/${id}`, 'PUT', { ...event, title:'Revisão concluída', completed:true });
  assert.equal(updated.data.completed, 1);
  assert.equal(updated.data.title, 'Revisão concluída');
  assert.equal((await request(`/api/events/${id}`, 'DELETE')).status, 200);
  assert.deepEqual((await request('/api/events?month=2026-10')).data, []);
  assert.equal((await request(`/api/events/${id}`, 'PUT', event)).status, 404);
});
test('API exige login e mantém os dados isolados entre usuários', async () => {
  assert.equal((await request('/api/events?month=2026-10','GET',undefined,'')).status,401);
  const other=await request('/api/auth/register','POST',{name:'Outra pessoa',email:'other@example.test',password:'outra-senha-123'});
  assert.equal(other.status,200);
  assert.equal((await request('/api/notes?month=2026-10','GET',undefined,other.cookie)).data.content,'');
  const item=await request('/api/events','POST',{...event,date:'2028-01-05'});
  assert.equal((await request(`/api/events/${item.data.id}`,'DELETE',undefined,other.cookie)).status,404);
  assert.equal((await request('/api/events?month=2028-01','GET',undefined,other.cookie)).data.length,0);
  assert.equal((await request('/api/auth/login','POST',{email:'other@example.test',password:'senha-errada-123'})).status,401);
  const login=await request('/api/auth/login','POST',{email:'other@example.test',password:'outra-senha-123'});
  assert.equal(login.status,200);assert.match(login.cookie,/florir_session=/);
  await request('/api/auth/logout','POST',{},login.cookie);
  assert.equal((await request('/api/tasks','GET',undefined,login.cookie)).status,401);
  assert.notEqual(store.db.prepare('SELECT password FROM users WHERE email=?').get('other@example.test').password,'outra-senha-123');
});
test('histórico persiste edições, protege alterações posteriores e desfaz exclusões', async () => {
  const created=await request('/api/events','POST',{...event,date:'2028-02-10'}),id=created.data.id;
  const updated=await request(`/api/events/${id}`,'PUT',{...event,date:'2028-02-10',title:'Novo título'});
  assert.equal((await request(`/api/history/${created.data.historyId}/undo`,'POST',{})).status,409);
  const deleted=await request(`/api/events/${id}`,'DELETE');
  assert.equal((await request('/api/events?month=2028-02')).data.length,0);
  assert.ok((await request('/api/trash')).data.some(item=>item.id===id&&item.entity==='event'));
  assert.equal((await request(`/api/history/${deleted.data.historyId}/undo`,'POST',{})).status,200);
  assert.equal((await request('/api/events?month=2028-02')).data[0].title,'Novo título');
  assert.equal((await request(`/api/history/${updated.data.historyId}/undo`,'POST',{})).status,200);
  assert.equal((await request('/api/events?month=2028-02')).data[0].title,event.title);
  assert.equal((await request(`/api/history/${updated.data.historyId}/undo`,'POST',{})).status,409);
  const another=await request('/api/auth/register','POST',{name:'Terceira',email:'third@example.test',password:'senha-segura-123'});
  assert.equal((await request(`/api/history/${created.data.historyId}/undo`,'POST',{},another.cookie)).status,409);
});
test('lixeira restaura tarefas e versões de anotações são recuperáveis', async () => {
  const task=await request('/api/tasks','POST',{title:'Tarefa restaurável'});
  await request(`/api/tasks/${task.data.id}`,'DELETE');
  assert.equal((await request(`/api/trash/task/${task.data.id}/restore`,'POST',{})).status,200);
  assert.ok((await request('/api/tasks')).data.some(item=>item.id===task.data.id));
  const first=await request('/api/notes?month=2028-03','PUT',{content:'Versão 1'});
  await request('/api/notes?month=2028-03','PUT',{content:'Versão 2'});
  assert.equal((await request(`/api/history/${first.data.historyId}/version`,'POST',{})).status,200);
  assert.equal((await request('/api/notes?month=2028-03')).data.content,'Versão 1');
  assert.equal((await request('/api/history?note=2028-03')).data.length,3);
});
test('recorrência semanal cruza meses e conflitos exigem confirmação explícita', async () => {
  const recurring=await request('/api/events','POST',{...event,date:'2027-01-25',recurrence:'weekly',until:'2027-02-15'});
  assert.equal(recurring.status,201);
  const feb=(await request('/api/events?month=2027-02')).data;
  assert.deepEqual(feb.map(item=>item.date),['2027-02-01','2027-02-08','2027-02-15']);
  assert.equal(feb[0].series_date,'2027-01-25');
  const conflict={...event,date:'2027-02-08',start:'14:30',end:'15:30'};
  const rejected=await request('/api/events','POST',conflict);
  assert.equal(rejected.status,409);assert.ok(rejected.data.conflicts.length);
  assert.equal((await request('/api/events','POST',{...conflict,allowConflict:true})).status,201);
  assert.equal((await request('/api/events','POST',{...event,date:'2027-02-08',start:'15:30',end:'16:00'})).status,201);
});
test('recorrência mensal ignora dias inexistentes e limita duração', async () => {
  assert.equal((await request('/api/events','POST',{...event,date:'2027-01-31',recurrence:'monthly',until:'2027-04-30'})).status,201);
  assert.equal((await request('/api/events?month=2027-02')).data.filter(item=>item.series_date==='2027-01-31').length,0);
  assert.equal((await request('/api/events?month=2027-03')).data.filter(item=>item.series_date==='2027-01-31')[0].date,'2027-03-31');
  assert.equal((await request('/api/events','POST',{...event,recurrence:'daily',until:'2030-10-19'})).status,400);
});
test('exportação e importação ICS preservam textos, recorrência e evitam duplicação', async () => {
  const response=await fetch(`${base}/api/calendar/export`,{headers:{Cookie:sessionCookie}});
  assert.equal(response.status,200);const content=await response.text();assert.match(content,/BEGIN:VCALENDAR/);
  const account=await request('/api/auth/register','POST',{name:'Importação',email:'import@example.test',password:'senha-segura-123'});
  const first=await request('/api/calendar/import','POST',{content,allowConflict:true},account.cookie);
  assert.equal(first.status,201);assert.ok(first.data.imported>0);
  const repeated=await request('/api/calendar/import','POST',{content,allowConflict:true},account.cookie);
  assert.equal(repeated.data.imported,0);assert.ok(repeated.data.skipped>0);
  assert.equal((await request('/api/calendar/import','POST',{content:'arquivo inválido'},account.cookie)).status,400);
});
test('demonstração cria uma agenda isolada e não reivindica dados pessoais', async () => {
  const demo=await request('/api/auth/demo','POST',{},'');assert.equal(demo.status,200);assert.equal(demo.data.user.demo,1);
  assert.equal((await request('/api/tasks','GET',undefined,demo.cookie)).data.length,3);
  assert.equal((await request('/api/notes?month=2028-03','GET',undefined,demo.cookie)).data.content,'');
});
test('validação rejeita datas impossíveis, horários invertidos e conteúdo inválido', async () => {
  for (const override of [{date:'2026-02-30'}, {start:'16:00'}, {end:'25:00'}, {title:' '}, {category:'inexistente'}, {completed:'false'}]) {
    assert.equal((await request('/api/events','POST',{...event,...override})).status,400);
  }
  assert.equal((await request('/api/events?month=2026-13')).status,400);
  assert.equal((await request('/api/events','POST',null)).status,400);
});
test('tarefas podem ser criadas, concluídas, consultadas e excluídas', async () => {
  const created=await request('/api/tasks','POST',{title:'Beber água'});
  assert.equal(created.status,201);
  const id=created.data.id;
  assert.equal((await request(`/api/tasks/${id}`,'PATCH',{completed:true})).status,200);
  assert.equal((await request('/api/tasks')).data[0].completed,1);
  assert.equal((await request(`/api/tasks/${id}`,'DELETE')).status,200);
  assert.ok(!(await request('/api/tasks')).data.some(task=>task.id===id));
  assert.equal((await request('/api/tasks','POST',{title:' '})).status,400);
});
test('anotações são salvas e isoladas por mês', async () => {
  assert.equal((await request('/api/notes?month=2026-10','PUT',{content:'Meus planos ♡'})).status,200);
  assert.equal((await request('/api/notes?month=2026-10')).data.content,'Meus planos ♡');
  assert.equal((await request('/api/notes?month=2026-11')).data.content,'');
  await request('/api/notes?month=2026-10','PUT',{content:'Atualizado'});
  assert.equal((await request('/api/notes?month=2026-10')).data.content,'Atualizado');
});
test('interface servida e arquivos privados inacessíveis', async () => {
  const response=await fetch(base);
  assert.equal(response.status,200);
  assert.match(await response.text(),/Florir/);
  assert.equal((await fetch(`${base}/style.css`)).status,200);
  assert.equal((await fetch(`${base}/app.js`)).status,200);
  assert.equal((await fetch(`${base}/data/agenda.sqlite`)).status,404);
  assert.equal((await fetch(`${base}/server.js`)).status,404);
});
test('operações vindas de outro site são bloqueadas', async () => {
  const response = await fetch(`${base}/api/events`, {
    method:'POST', headers:{'Content-Type':'application/json', Origin:'https://outro-site.example'}, body:JSON.stringify(event)
  });
  assert.equal(response.status,403);
});
test('anotações diárias são independentes das mensais e aparecem no mês correto', async () => {
  assert.equal((await request('/api/day-notes/2026-10-19','PUT',{content:'Separar documentos'})).status,200);
  assert.equal((await request('/api/day-notes/2026-10-20','PUT',{content:'Revisar relatório'})).status,200);
  assert.deepEqual((await request('/api/day-notes?month=2026-10')).data, [
    {date:'2026-10-19',content:'Separar documentos'}, {date:'2026-10-20',content:'Revisar relatório'}
  ]);
  assert.deepEqual((await request('/api/day-notes?month=2026-11')).data,[]);
  assert.equal((await request('/api/notes?month=2026-10')).data.content,'Atualizado');
  await request('/api/day-notes/2026-10-19','PUT',{content:''});
  assert.equal((await request('/api/day-notes?month=2026-10')).data.length,1);
  assert.equal((await request('/api/day-notes/2026-02-30','PUT',{content:'Inválido'})).status,400);
  assert.equal((await request('/api/day-notes?month=2026-13')).status,400);
  assert.equal((await request('/api/day-notes/2026-10-19','PUT',{content:123})).status,400);
});
