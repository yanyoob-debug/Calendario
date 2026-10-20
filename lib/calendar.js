export const categories = ['pessoal', 'trabalho', 'estudos', 'saude'];
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
export const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0,10);
export function validateEvent(value) {
  const {title, description = '', date, start, end, category, completed = false, recurrence = 'none', repeatCount} = value;
  let {until = ''} = value;
  if (typeof title !== 'string' || !title.trim() || title.length > 120) throw Error('Informe um título de até 120 caracteres.');
  if (typeof description !== 'string' || description.length > 3000) throw Error('Descrição inválida.');
  if (!validDate(date)) throw Error('Informe uma data válida.');
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof start!=='string' || typeof end!=='string' || !time.test(start) || !time.test(end) || end <= start) throw Error('O término deve ser depois do início.');
  if (!categories.includes(category)) throw Error('Categoria inválida.');
  if (typeof completed !== 'boolean') throw Error('Estado inválido.');
  if (!['none','daily','weekly','monthly'].includes(recurrence)) throw Error('Repetição inválida.');
  if (recurrence !== 'none' && repeatCount !== undefined) {
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 367) throw Error('Informe uma quantidade inteira entre 1 e 367 ocorrências.');
    const dates = occurrences({date, recurrence, until:addDays(date,366)}, date, addDays(date,366));
    if (!dates[repeatCount-1]) throw Error('Essa quantidade ultrapassa o limite de um ano. Reduza o número de ocorrências.');
    until = dates[repeatCount-1].date;
  }
  if (recurrence !== 'none' && (!validDate(until) || until < date || until > addDays(date,366))) throw Error('Defina o fim da repetição em até um ano após o início.');
  return {title:title.trim(), description:description.trim(), date, start, end, category, completed:Number(completed), recurrence, until:recurrence === 'none' ? '' : until};
}
export function occurrences(event, from, to) {
  if (event.deleted_at || event.date > to) return [];
  if (event.recurrence === 'none' || !event.recurrence) return event.date >= from && event.date <= to ? [{...event,series_date:event.date}] : [];
  const result = [], last = event.until < to ? event.until : to;
  const base = new Date(`${event.date}T12:00:00Z`);
  for (let i=0; i<=366; i++) {
    let date;
    if (event.recurrence === 'monthly') {
      const next = new Date(base);
      next.setUTCMonth(base.getUTCMonth()+i);
      // A monthly event on day 31 skips months without that day.
      if (next.getUTCDate() !== base.getUTCDate()) continue;
      date = next.toISOString().slice(0,10);
    } else date = addDays(event.date,i*(event.recurrence === 'weekly'?7:1));
    if (date > last) break;
    if (date >= from) result.push({...event,date,series_date:event.date});
  }
  return result;
}
export function findConflicts(candidate, existing) {
  const end = candidate.until || candidate.date;
  const times = new Map(occurrences(candidate,candidate.date,end).map(e=>[e.date,e]));
  const result = [];
  for (const item of existing) {
    if (candidate.id !== undefined && candidate.id !== null && item.id === candidate.id) continue;
    for (const other of occurrences(item,candidate.date,end)) {
      const event = times.get(other.date);
      if (event && event.start < other.end && event.end > other.start) result.push({id:item.id,title:item.title,date:other.date,start:other.start,end:other.end});
      if (result.length >= 10) return result;
    }
  }
  return result;
}
const escapeICS = text => text.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
const unescapeICS = text => text.replace(/\\([nN,;\\])/g,(_,char)=>/[nN]/.test(char)?'\n':char);
function fold(line) {
  const parts=[]; let part='';
  for (const char of line) { if (Buffer.byteLength(part+char)>73) {parts.push(part);part=' '+char;} else part+=char; }
  parts.push(part);return parts.join('\r\n');
}
export function exportICS(events) {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Florir//Agenda//PT-BR','CALSCALE:GREGORIAN'];
  for (const event of events) {
    const stamp = (date,time)=>date.replaceAll('-','')+'T'+time.replace(':','')+'00';
    lines.push('BEGIN:VEVENT',`UID:florir-${event.id}@agenda.local`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,`DTSTART:${stamp(event.date,event.start)}`,`DTEND:${stamp(event.date,event.end)}`,`SUMMARY:${escapeICS(event.title)}`,`DESCRIPTION:${escapeICS(event.description)}`,`CATEGORIES:${event.category}`);
    if(event.recurrence!=='none') lines.push(`RRULE:FREQ=${event.recurrence.replace('daily','DAILY').replace('weekly','WEEKLY').replace('monthly','MONTHLY')};UNTIL=${event.until.replaceAll('-','')}T235959`);
    lines.push('END:VEVENT');
  }
  return lines.concat('END:VCALENDAR','').map(fold).join('\r\n');
}
export function parseICS(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text)>500000 || !text.trim().startsWith('BEGIN:VCALENDAR') || !text.trim().endsWith('END:VCALENDAR')) throw Error('Selecione um arquivo .ics válido e completo de até 500 KB.');
  const lines=text.replace(/\r?\n[ \t]/g,'').split(/\r?\n/), result=[];
  let current=null,inCalendar=false,ended=false;
  for (const line of lines) {
    if(line==='BEGIN:VCALENDAR'){if(inCalendar||ended)throw Error('Estrutura de calendário inválida.');inCalendar=true;continue;}
    if(line==='END:VCALENDAR'){if(!inCalendar||current)throw Error('Estrutura de calendário inválida.');inCalendar=false;ended=true;continue;}
    if(!inCalendar){if(line.trim())throw Error('Conteúdo fora do calendário.');continue;}
    if(line==='BEGIN:VEVENT'){if(current)throw Error('Evento inválido.');current=Object.create(null);continue;}
    if(line.startsWith('BEGIN:')||(line.startsWith('END:')&&line!=='END:VEVENT'))throw Error('O arquivo contém componentes de calendário não suportados.');
    if(line==='END:VEVENT'){
      if(!current)throw Error('Evento inválido.');
      if(current.RDATE || current.EXDATE || current['RECURRENCE-ID'] || current.DURATION) throw Error('O arquivo contém exceções ou durações não suportadas. Nenhum evento foi importado.');
      const dateTime = (entry) => {
        if (!entry || !/^\d{8}T\d{6}Z?$/.test(entry.value)) throw Error('Importe compromissos com data e horário (eventos de dia inteiro não são suportados).');
        const zone=entry.key.split(';').find(part=>part.startsWith('TZID='))?.slice(5);
        if(zone && zone!=='America/Sao_Paulo') throw Error('Este arquivo usa um fuso diferente de America/Sao_Paulo.');
        const v=entry.value, date=`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`, time=`${v.slice(9,11)}:${v.slice(11,13)}`;
        if(!validDate(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||v.slice(13,15)!=='00') throw Error('Data ou horário inválido. Use horários com precisão de minutos (segundos 00).');
        if(v.endsWith('Z')) {
          const instant=new Date(`${date}T${time}:${v.slice(13,15)}Z`);
          if(!Number.isFinite(instant.getTime())) throw Error('Data inválida no arquivo.');
          const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(p=>[p.type,p.value]));
          return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
        }
        return {date,time};
      };
      const start=dateTime(current.DTSTART), end=dateTime(current.DTEND);
      if(start.date!==end.date)throw Error('Compromissos que atravessam a meia-noite não são suportados.');
      let recurrence='none',until='';
      if(current.RRULE){
        const rule=Object.fromEntries(current.RRULE.value.split(';').map(item=>item.split('=')));
        if(Object.keys(rule).some(key=>!['FREQ','UNTIL','INTERVAL'].includes(key)) || (rule.INTERVAL && rule.INTERVAL!=='1') || !['DAILY','WEEKLY','MONTHLY'].includes(rule.FREQ) || !/^\d{8}T235959$/.test(rule.UNTIL||'')) throw Error('Repetição não suportada. Use diária, semanal ou mensal com data final (até um ano).');
        recurrence=rule.FREQ.toLowerCase();until=`${rule.UNTIL.slice(0,4)}-${rule.UNTIL.slice(4,6)}-${rule.UNTIL.slice(6,8)}`;
      }
      result.push(validateEvent({title:unescapeICS(current.SUMMARY?.value||''),description:unescapeICS(current.DESCRIPTION?.value||''),date:start.date,start:start.time,end:end.time,category:categories.includes(current.CATEGORIES?.value)?current.CATEGORIES.value:'pessoal',recurrence,until}));
      if(result.length>200)throw Error('Importe até 200 compromissos por arquivo.');
      current=null;continue;
    }
    if(current){const colon=line.indexOf(':');if(colon>0){const key=line.slice(0,colon),name=key.split(';')[0];if(['DTSTART','DTEND','SUMMARY','RRULE'].includes(name)&&current[name])throw Error('O evento contém campos duplicados.');current[name]={key,value:line.slice(colon+1)};}}
  }
  if(current || !ended || !result.length)throw Error('Nenhum compromisso válido encontrado.');
  return result;
}
