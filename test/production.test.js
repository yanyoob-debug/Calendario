import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH=':memory:';
process.env.NODE_ENV='production';
process.env.PUBLIC_ORIGIN='https://agenda.example.test';
process.env.SETUP_TOKEN='codigo-apenas-do-teste-nao-e-um-segredo-real';
const {server,store}=await import('../server.js');
let base,cookie;
const account={name:'Proprietário',email:'production@example.test',password:'senha-producao-teste'};
async function request(path,method='GET',body,headers={}){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie||'',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data,headers:response.headers};
}
before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;store.setNote(0,'2026-10','Dados do proprietário');});
after(async()=>{await new Promise(resolve=>server.close(resolve));store.db.close();});
test('primeira conta online exige o código e não expõe dados legados sem autorização',async()=>{
  assert.equal((await request('/api/auth/register','POST',account)).status,403);
  assert.equal((await request('/api/auth/register','POST',{...account,setupToken:'incorreto'})).status,403);
  assert.equal((await request('/api/notes?month=2026-10')).status,401);
  const result=await request('/api/auth/register','POST',{...account,setupToken:process.env.SETUP_TOKEN});assert.equal(result.status,200);
  cookie=result.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/notes?month=2026-10')).data.content,'Dados do proprietário');
  assert.match(result.headers.get('set-cookie'),/; Secure/);
});
test('origem pública configurada é aceita e origens externas são recusadas',async()=>{
  assert.equal((await request('/api/tasks','POST',{title:'Tarefa válida'},{Origin:process.env.PUBLIC_ORIGIN,Host:'agenda.example.test'})).status,201);
  for(const origin of ['https://outro.example','null','http://agenda.example.test'])assert.equal((await request('/api/tasks','POST',{title:'Bloqueada'},{Origin:origin,Host:'agenda.example.test'})).status,403);
  assert.equal((await request('/api/tasks')).data.length,1);
});
test('página pública inclui proteção contra scripts inline e incorporação em frames',async()=>{
  const result=await request('/');assert.equal(result.status,200);
  assert.match(result.headers.get('content-security-policy'),/script-src 'self'/);
  assert.match(result.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(result.headers.get('x-content-type-options'),'nosniff');
});
test('novas contas não recebem o banco legado nem dados da primeira conta',async()=>{
  const result=await request('/api/auth/register','POST',{...account,email:'second@example.test',name:'Segunda conta'});assert.equal(result.status,200);
  const another=result.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/notes?month=2026-10','GET',undefined,{Cookie:another})).data.content,'');
  assert.deepEqual((await request('/api/tasks','GET',undefined,{Cookie:another})).data,[]);
});
