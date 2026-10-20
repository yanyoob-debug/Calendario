import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportICS, parseICS, validateEvent, occurrences } from '../lib/calendar.js';
const sample=validateEvent({title:'Revisão, café; planejamento',description:'Linha 1\nLinha 2 \\ referências',date:'2026-10-20',start:'09:00',end:'10:00',category:'estudos',recurrence:'weekly',until:'2026-11-20'});

test('quantidade de repetições inclui o primeiro compromisso e encerra na ocorrência exata',()=>{
  for(const [recurrence, repeatCount, until] of [['daily',3,'2026-10-22'],['weekly',4,'2026-11-10'],['monthly',3,'2026-12-20'],['weekly',1,'2026-10-20']]){
    const event=validateEvent({...sample,completed:false,recurrence,repeatCount});
    assert.equal(event.until,until);
    assert.equal(occurrences(event,event.date,'2027-10-21').length,repeatCount);
  }
});

test('quantidade mensal pula meses sem o dia e rejeita valores inválidos ou além de um ano',()=>{
  const event=validateEvent({...sample,completed:false,date:'2028-01-31',recurrence:'monthly',repeatCount:3});
  assert.equal(event.until,'2028-05-31');
  assert.deepEqual(occurrences(event,event.date,event.until).map(e=>e.date),['2028-01-31','2028-03-31','2028-05-31']);
  for(const repeatCount of [0,-1,1.5,'3',null,368])assert.throws(()=>validateEvent({...sample,completed:false,repeatCount}));
  assert.throws(()=>validateEvent({...sample,completed:false,recurrence:'weekly',repeatCount:54}),/um ano/);
});
test('ICS preserva escapes, acentos e linhas dobradas sem perder dados',()=>{
  const value={...sample,id:1,description:sample.description+'\n'+'Anotação longa com acentuação. '.repeat(20).trim()};
  const encoded=exportICS([value]),[decoded]=parseICS(encoded);
  assert.equal(decoded.title,value.title);assert.equal(decoded.description,value.description);
  assert.equal(decoded.recurrence,value.recurrence);assert.equal(decoded.until,value.until);
  assert.ok(encoded.split('\r\n').every(line=>Buffer.byteLength(line)<=75));
});
test('ICS UTC é convertido para São Paulo e regras não suportadas são rejeitadas',()=>{
  const utc='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261020T120000Z\r\nDTEND:20261020T130000Z\r\nSUMMARY:Reunião\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.equal(parseICS(utc)[0].start,'09:00');
  assert.throws(()=>parseICS(utc.replace('SUMMARY:Reunião','RRULE:FREQ=WEEKLY;COUNT=4\r\nSUMMARY:Reunião')),/Repetição não suportada/);
  assert.throws(()=>parseICS(utc.replace('DTSTART:20261020T120000Z','DTSTART;VALUE=DATE:20261020')),/dia inteiro/);
});
test('ocorrências diárias respeitam ano bissexto e limites inclusivos',()=>{
  const event=validateEvent({...sample,completed:false,date:'2028-02-28',recurrence:'daily',until:'2028-03-01'});
  assert.deepEqual(occurrences(event,'2028-02-01','2028-03-31').map(item=>item.date),['2028-02-28','2028-02-29','2028-03-01']);
});
test('ICS rejeita datas normalizadas, segundos, fusos falsos e arquivos truncados',()=>{
  const base='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260228T120000Z\r\nDTEND:20260228T130000Z\r\nSUMMARY:Teste\r\nEND:VEVENT\r\nEND:VCALENDAR';
  for(const value of [base.replaceAll('20260228','20260230'),base.replace('T120000Z','T120059Z'),base.replace('DTSTART:','DTSTART;TZID=America/Sao_Paulo-falso:'),base.replace('END:VCALENDAR',''),base.replace('SUMMARY:Teste','BEGIN:VALARM\r\nSUMMARY:Alarme\r\nEND:VALARM'),base.replace('SUMMARY:Teste','SUMMARY:Teste\r\nSUMMARY:Outro')])assert.throws(()=>parseICS(value));
});
test('recorrência mensal preserva anos anteriores a 100 sem saltar para 1900',()=>{
  const event=validateEvent({...sample,completed:false,date:'0099-01-31',recurrence:'monthly',until:'0099-03-31'});
  assert.deepEqual(occurrences(event,'0099-01-01','0099-04-01').map(item=>item.date),['0099-01-31','0099-03-31']);
});
