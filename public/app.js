import { matchesSearch } from './search.js';

const $ = (selector) => document.querySelector(selector);
const today = new Date();
let selected = new Date(today.getFullYear(), today.getMonth(), 1);
let events = [], tasks = [], filter = '', query = '', requestId = 0, notesDirty = false;
const savedNotes = new Map(), noteDrafts = new Map(), savingNotes = new Set();
let noteScope = 'month', noteDay, notesReady = false;
let calendarView='month', lastHistoryId=null;
let historyMode='history', historyNote=null, historyOffset=0;
const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const colors = ['#ede5f4','#f6e6ef','#e7edf7','#e6f1ed','#f7f0db','#f9e7de','#ede6f6','#f7e8ed','#e8eff7','#eee4f5','#e6f0ed','#f7eddd'];
const categories = { pessoal: 'Pessoal', trabalho: 'Trabalho', estudos: 'Estudos', saude: 'Saúde & bem-estar' };
const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const monthKey = () => localDate(selected).slice(0,7);
noteDay = localDate(today);
const currentNoteKey = () => noteScope === 'day' ? noteDay : monthKey();
const noteContent = key => noteDrafts.get(key) ?? savedNotes.get(key) ?? '';
function element(tag, className, text) { const el = document.createElement(tag); if(className) el.className = className; if(text !== undefined) el.textContent = text; return el; }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type':'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(Error(data.error || 'Não foi possível concluir.'),{status:response.status,conflicts:data.conflicts});
  }
  if(data.historyId){lastHistoryId=data.historyId;$('#undo-last').disabled=false;}
  return data;
}
let toastTimer;
function toast(message,historyId) {
  $('#toast').replaceChildren(element('span','',message));
  if(historyId){const button=element('button','toast-undo','Desfazer');button.onclick=()=>undoAction(historyId);$('#toast').append(button);}
  const dismiss=element('button','toast-dismiss','×');dismiss.setAttribute('aria-label','Fechar aviso');dismiss.onclick=()=>$('#toast').hidden=true;$('#toast').append(dismiss);
  $('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,historyId?10000:4500);
}
$('#today-label').textContent = today.toLocaleDateString('pt-BR',{ weekday:'long',day:'numeric',month:'long' });
async function loadMonth() {
  const id = ++requestId, month = monthKey();
  if (noteDay.slice(0,7) !== month) noteDay = month === localDate(today).slice(0,7) ? localDate(today) : `${month}-01`;
  notesReady = false;
  $('#month-title').textContent = `${monthNames[selected.getMonth()]} ${selected.getFullYear()}`;
  $('#notes').value = ''; $('#notes').disabled = true; $('#save-notes').disabled = true;
  $('#notes-status').textContent = 'Carregando…';
  events = []; renderCalendar(); renderTabs(); renderFilters();
  try {
    const first=new Date(selected.getFullYear(),selected.getMonth(),1),last=new Date(selected.getFullYear(),selected.getMonth()+1,0);
    first.setDate(first.getDate()-6);last.setDate(last.getDate()+6);
    const [loadedEvents, note, dayNotes] = await Promise.all([api(`/events?from=${localDate(first)}&to=${localDate(last)}`), api(`/notes?month=${month}`), api(`/day-notes?month=${month}`)]);
    if (id !== requestId) return;
    events = loadedEvents;
    for (const key of savedNotes.keys()) if (key.startsWith(`${month}-`)) savedNotes.delete(key);
    savedNotes.set(month, note.content);
    dayNotes.forEach(note => savedNotes.set(note.date, note.content));
    notesReady = true;
    renderNotes();
    renderCalendar(); renderFilters();
  } catch (error) { if (id === requestId) { toast(error.message); $('#notes-status').textContent = 'Falha ao carregar'; } }
}
function renderTabs() {
  $('#month-tabs').replaceChildren(...monthNames.map((month, index) => {
    const button = element('button', `month-tab${index === selected.getMonth() ? ' active' : ''}`, month.slice(0,3).toUpperCase());
    button.style.setProperty('--tab-color', colors[index]);
    button.setAttribute('aria-label', `${month} de ${selected.getFullYear()}`);
    button.setAttribute('aria-pressed', String(index === selected.getMonth()));
    button.onclick = () => navigate(new Date(selected.getFullYear(), index, 1));
    return button;
  }));
}
function renderFilters() {
  if(!$('#category-filters').children.length)$('#category-filters').replaceChildren(...Object.entries(categories).map(([key,label]) => {
    const button = element('button',`category-filter category-${key}`);
    button.dataset.category=key;
    button.append(element('span','category-dot'),element('span','',label),element('small','','0'));
    button.onclick=()=>{filter=filter===key?'':key;renderFilters();renderCalendar();};
    return button;
  }));
  for(const button of $('#category-filters').children){button.setAttribute('aria-pressed',String(filter===button.dataset.category));button.querySelector('small').textContent=events.filter(e=>e.category===button.dataset.category&&e.date.startsWith(monthKey())).length;}
  $('#clear-filter').hidden = !filter;
}
function renderCalendar() {
  const first = new Date(selected.getFullYear(),selected.getMonth(),1);
  const days = new Date(selected.getFullYear(),selected.getMonth()+1,0).getDate();
  const cells = Math.ceil((first.getDay()+days)/7)*7;
  const visible = events.filter(e=>(!filter||e.category===filter)&&matchesSearch(e, query));
  const nodes = [];
  for(let i=0;i<cells;i++) {
    const date = new Date(selected.getFullYear(),selected.getMonth(),i-first.getDay()+1), key=localDate(date);
    const cell = element('div',`day${date.getMonth()!==selected.getMonth()?' other-month':''}${i%7===0||i%7===6?' weekend':''}${key===localDate(today)?' is-today':''}`);
    cell.dataset.date=key;
    const day = element('button','day-number',date.getDate());
    day.setAttribute('aria-label',`Ver dia e anotações de ${date.toLocaleDateString('pt-BR')}`);
    day.onclick=()=>selectNoteDay(key);
    const add = element('button','day-add','＋');
    add.setAttribute('aria-label',`Adicionar compromisso em ${date.toLocaleDateString('pt-BR')}`);
    add.onclick=()=>openEvent(null,key);
    cell.append(day,add);
    if (key === noteDay) cell.classList.add('selected-day');
    if (noteContent(key).trim()) {
      cell.append(createNoteMarker(key));
    }
    visible.filter(event=>event.date===key).forEach(event=>{
      const button=element('button',`event category-${event.category}${event.completed?' completed':''}`);
      button.append(element('time','',`${event.start}${event.recurrence!=='none'?' ↻':''}`),element('span','event-title',event.title));
      button.title=`${event.start}–${event.end} · ${event.title}`;
      button.onclick=()=>openEvent(event);
      cell.append(button);
    });
    cell.onclick=(e)=>{if(e.target===cell)selectNoteDay(key);};
    nodes.push(cell);
  }
  $('#calendar').replaceChildren(...nodes);
  const monthly=visible.filter(event=>event.date.startsWith(monthKey()));
  $('#event-count').textContent=`${monthly.length} ocorrência${monthly.length===1?'':'s'} no mês${filter||query?' · com filtro':''}`;
  renderSchedule(visible);
  renderDayOverview();
}
function renderSchedule(visible) {
  $('#calendar').hidden=calendarView!=='month';$('.weekdays').hidden=calendarView!=='month';$('#month-tabs').hidden=calendarView!=='month';$('#schedule').hidden=calendarView==='month';
  document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===calendarView)));
  $('#prev-month').setAttribute('aria-label',calendarView==='month'?'Mês anterior':calendarView==='week'?'Semana anterior':'Dia anterior');
  $('#next-month').setAttribute('aria-label',calendarView==='month'?'Próximo mês':calendarView==='week'?'Próxima semana':'Próximo dia');
  if(calendarView==='month'){$('#month-title').textContent=`${monthNames[selected.getMonth()]} ${selected.getFullYear()}`;return;}
  const anchor=new Date(`${noteDay}T12:00:00`),start=new Date(anchor);
  if(calendarView==='week')start.setDate(start.getDate()-(start.getDay()+6)%7);
  const count=calendarView==='week'?7:1,nodes=[];
  for(let i=0;i<count;i++){
    const date=new Date(start);date.setDate(date.getDate()+i);const key=localDate(date),card=element('section',`schedule-day${key===localDate(today)?' today':''}`);
    const heading=element('button','schedule-heading',date.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'}));
    heading.onclick=()=>selectNoteDay(key);card.append(heading);
    const daily=visible.filter(event=>event.date===key);
    daily.forEach(event=>{
      const button=element('button',`schedule-event category-${event.category}${event.completed?' completed':''}`);
      button.append(element('time','',`${event.start} – ${event.end}`),element('strong','',event.title));
      if(event.recurrence!=='none')button.append(element('small','','↻ Recorrente'));
      if(calendarView==='day'&&event.description)button.append(element('p','',event.description));
      button.onclick=()=>openEvent(event);card.append(button);
    });
    if(!daily.length)card.append(element('p','empty-message','Sem compromissos'));
    const add=element('button','schedule-add','＋ Adicionar');add.onclick=()=>openEvent(null,key);card.append(add);nodes.push(card);
  }
  $('#schedule').classList.toggle('daily',calendarView==='day');$('#schedule').replaceChildren(...nodes);
  const end=new Date(start);end.setDate(end.getDate()+count-1);
  $('#month-title').textContent=calendarView==='day'?anchor.toLocaleDateString('pt-BR',{day:'numeric',month:'long',year:'numeric'}):`${start.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})} – ${end.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}`;
}
function renderNotes() {
  const key = currentNoteKey(), content = noteContent(key);
  $('#notes').value = content;
  $('#notes').disabled = !notesReady;
  $('#notes-month').setAttribute('aria-pressed',String(noteScope === 'month'));
  $('#notes-day').setAttribute('aria-pressed',String(noteScope === 'day'));
  $('#notes-period').textContent = noteScope === 'month' ? `${monthNames[selected.getMonth()]} de ${selected.getFullYear()}` : new Date(`${noteDay}T12:00:00`).toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  $('#notes-label').textContent = noteScope === 'month' ? 'Anotações do mês' : 'Anotações do dia';
  updateNoteStatus();
  renderDayOverview();
}
function updateNoteStatus(message) {
  const key = currentNoteKey(), saving = savingNotes.has(key), dirty = noteDrafts.has(key);
  notesDirty = noteDrafts.size > 0;
  $('#save-notes').disabled = !notesReady || saving || !dirty;
  $('#save-notes').textContent = saving ? 'Salvando…' : 'Salvar anotações';
  $('#notes-status').textContent = message || (saving ? 'Salvando…' : dirty ? 'Alterações não salvas' : 'Todas as alterações salvas');
  $('#notes-status').classList.toggle('unsaved',dirty);
  $('#notes-length').textContent = `${$('#notes').value.length.toLocaleString('pt-BR')} / 10.000`;
}
function renderDayOverview() {
  $('#day-title').textContent = `Dia ${noteDay.slice(8,10)}/${noteDay.slice(5,7)}`;
  const daily = events.filter(event => event.date === noteDay);
  $('#day-events').replaceChildren(...(daily.length ? daily.map(event => {
    const button = element('button',`event category-${event.category}${event.completed?' completed':''}`);
    button.append(element('time','',`${event.start} – ${event.end}`),element('span','event-title',event.title));
    button.onclick=()=>openEvent(event);return button;
  }) : [element('p','empty-message','Nenhum compromisso neste dia.')]));
}
async function selectNoteDay(key) {
  if (key.slice(0,7) !== monthKey()) {
    if (!await navigate(new Date(`${key.slice(0,7)}-01T12:00:00`))) return;
  }
  noteDay = key;noteScope = 'day';renderNotes();renderCalendar();
  if (matchMedia('(max-width: 1100px)').matches) $('#notes-panel').scrollIntoView({behavior:'smooth',block:'start'});
  $('#notes').focus({preventScroll:true});
}
async function saveNotes(key = currentNoteKey()) {
  if (!noteDrafts.has(key)) return true;
  if (savingNotes.has(key)) return false;
  const content = noteDrafts.get(key);
  savingNotes.add(key);updateNoteStatus();
  try {
    const result=await api(key.length === 7 ? `/notes?month=${key}` : `/day-notes/${key}`,{method:'PUT',body:{content}});
    if(result.historyId)toast('Anotações salvas.',result.historyId);
    savedNotes.set(key, content);
    if (noteDrafts.get(key) === content) noteDrafts.delete(key);
    return !noteDrafts.has(key);
  } catch(error){toast('Não foi possível salvar. Seu texto foi mantido.');return false;}
  finally { savingNotes.delete(key);updateNoteStatus();renderCalendar(); }
}
async function navigate(date) {
  for (const key of noteDrafts.keys()) if (!await saveNotes(key)) return false;
  selected=date;
  await loadMonth();
  return true;
}
function openEvent(event,date) {
  const form=$('#event-form');form.reset();
  for (const name of ['start', 'end']) form.elements[name].setCustomValidity('');
  $('#form-error').textContent='';
  $('#dialog-title').textContent=event?'Seu compromisso':'Novo compromisso';
  form.elements.id.value=event?.id||'';
  form.elements.date.value=event?.date||date|| (monthKey()===localDate(today).slice(0,7)?localDate(today):`${monthKey()}-01`);
  if(event){for(const key of ['title','description','start','end','category'])form.elements[key].value=event[key];form.elements.completed.checked=Boolean(event.completed);}
  if(event){form.elements.date.value=event.series_date||event.date;form.elements.recurrence.value=event.recurrence||'none';form.elements.until.value=event.until||'';form.elements.repeatEnd.value='date';}
  updateRecurrence();$('#conflict-warning').hidden=true;
  $('#delete-event').hidden=!event;
  $('#event-dialog').showModal();
}
for (const name of ['start', 'end']) {
  const input = $('#event-form').elements[name];
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', (event) => {
    const raw = input.value;
    let digits = raw.replace(/\D/g, '').slice(0, 4);
    let beforeCursor = raw.slice(0, input.selectionStart).replace(/\D/g, '').length;
    // A first digit above 2 can only belong to a one-digit hour (9 → 09).
    if (/^[3-9]/.test(digits)) { digits = `0${digits}`.slice(0, 4); beforeCursor++; }
    input.value = digits.length >= 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    const deleting = event.inputType?.startsWith('delete');
    const cursor = Math.min(input.value.length, beforeCursor + (beforeCursor > 2 || (beforeCursor === 2 && !deleting) ? 1 : 0));
    input.setSelectionRange(cursor, cursor);
    input.setCustomValidity('');
  });
  input.addEventListener('blur', () => {
    let digits = input.value.replace(/\D/g, '');
    if (!digits) return;
    if (digits.length <= 2) digits = digits.padStart(2, '0') + '00';
    const value = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) input.value = value;
    input.setCustomValidity(/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value) ? '' : 'Informe um horário válido entre 00:00 e 23:59.');
  });
}
$('#event-form').onsubmit=async(e)=>{
  e.preventDefault(); const form=e.currentTarget;
  const button=form.querySelector('[type=submit]');button.disabled=true;
  const id=form.elements.id.value;
  const value=Object.fromEntries(['title','description','date','start','end','category','recurrence','until'].map(key=>[key,form.elements[key].value]));
  value.completed=form.elements.completed.checked;
  value.allowConflict=form.elements.allowConflict.checked;
  if(value.recurrence!=='none' && form.elements.repeatEnd.value==='count')value.repeatCount=Number(form.elements.repeatCount.value);
  try {
    const result=await api(`/events${id?`/${id}`:''}`,{method:id?'PUT':'POST',body:value});
    $('#event-dialog').close();toast(id?'Compromisso atualizado.':'Compromisso criado.',result.historyId);
    const destination=new Date(`${value.date}T12:00:00`);
    await navigate(new Date(destination.getFullYear(),destination.getMonth(),1));
  } catch(error){$('#form-error').textContent=error.message;if(error.conflicts){$('#conflict-warning').hidden=false;$('#conflict-details').textContent=error.conflicts.map(item=>`${item.date.split('-').reverse().join('/')} · ${item.start}–${item.end}: ${item.title}`).join('\n');}}
  finally{button.disabled=false;}
};
$('#delete-event').onclick=async()=>{
  const button=$('#delete-event');button.disabled=true;
  try{const result=await api(`/events/${$('#event-form').elements.id.value}`,{method:'DELETE'});$('#event-dialog').close();toast('Compromisso movido para a lixeira.',result.historyId);await loadMonth();}
  catch(error){$('#form-error').textContent=error.message;}finally{button.disabled=false;}
};
function renderTasks() {
  $('#task-count').textContent=`${tasks.filter(task=>task.completed).length} / ${tasks.length}`;
  if(!tasks.length){$('#task-list').replaceChildren(element('p','empty-message','Nenhuma tarefa cadastrada.'));return;}
  $('#task-list').replaceChildren(...tasks.map(task=>{
    const row=element('div',`task-row${task.completed?' done':''}`),label=element('label'),checkbox=element('input');
    checkbox.type='checkbox';checkbox.checked=Boolean(task.completed);
    checkbox.onchange=async()=>{checkbox.disabled=true;try{const result=await api(`/tasks/${task.id}`,{method:'PATCH',body:{completed:checkbox.checked}});task.completed=Number(checkbox.checked);row.classList.toggle('done',Boolean(task.completed));$('#task-count').textContent=`${tasks.filter(task=>task.completed).length} / ${tasks.length}`;toast('Tarefa atualizada.',result.historyId);}catch(error){checkbox.checked=Boolean(task.completed);toast(error.message);}finally{checkbox.disabled=false;}};
    label.append(checkbox,element('span','',task.title));
    const remove=element('button','task-delete','×');remove.setAttribute('aria-label',`Excluir tarefa ${task.title}`);
    remove.onclick=async()=>{remove.disabled=true;try{const result=await api(`/tasks/${task.id}`,{method:'DELETE'});tasks=tasks.filter(t=>t.id!==task.id);renderTasks();toast('Tarefa movida para a lixeira.',result.historyId);}catch(error){toast(error.message);remove.disabled=false;}};
    row.append(label,remove);return row;
  }));
}
$('#task-form').onsubmit=async(e)=>{
  e.preventDefault();const input=e.currentTarget.elements.title,button=e.currentTarget.querySelector('button');button.disabled=true;
  try{const task=await api('/tasks',{method:'POST',body:{title:input.value}});tasks.unshift(task);input.value='';renderTasks();toast('Tarefa criada.',task.historyId);}
  catch(error){toast(error.message);}finally{button.disabled=false;}
};
$('#prev-month').onclick=()=>movePeriod(-1);
$('#next-month').onclick=()=>movePeriod(1);
$('#go-today').onclick=()=>{noteDay=localDate(today);navigate(new Date(today.getFullYear(),today.getMonth(),1));};
$('#new-event').onclick=()=>openEvent();
$('#close-dialog').onclick=()=>$('#event-dialog').close();
let searchTimer, searchVersion=0;
function closeSearchResults(){clearTimeout(searchTimer);searchVersion++;$('#search-results').hidden=true;$('#search').setAttribute('aria-expanded','false');}
function showSearchResults(items,status){
  const panel=$('#search-results');
  panel.replaceChildren(element('p','search-status',status));
  for(const event of items){
    const button=element('button','search-result');button.type='button';
    button.append(element('strong','',event.title));
    const date=new Date(`${event.date}T12:00:00`).toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'});
    button.append(element('span','',`${date} · ${event.start}–${event.end}`));
    if(event.recurrence!=='none')button.append(element('small','','↻ Série recorrente · abrir esta ocorrência'));
    button.onclick=async()=>{
      closeSearchResults();
      if(!await navigate(new Date(`${event.date.slice(0,7)}-01T12:00:00`)))return;
      query='';$('#search').value='';filter='';noteDay=event.date;calendarView='day';
      renderFilters();renderNotes();renderCalendar();$('.planner').scrollIntoView({behavior:'smooth',block:'start'});
      $('[data-view="day"]').focus({preventScroll:true});
    };
    panel.append(button);
  }
  panel.hidden=false;$('#search').setAttribute('aria-expanded','true');
}
function searchAppointments(){
  query=$('#search').value.trim();renderCalendar();clearTimeout(searchTimer);
  const version=++searchVersion;
  if(!query){closeSearchResults();return;}
  showSearchResults(events.filter(event=>matchesSearch(event,query)).filter((event,index,items)=>items.findIndex(item=>item.id===event.id)===index),'Buscando em toda a agenda…');
  searchTimer=setTimeout(async()=>{
    try{
      const results=await api(`/events/search?q=${encodeURIComponent(query)}&date=${localDate(today)}`);
      if(version!==searchVersion)return;
      showSearchResults(results,results.length?`${results.length===30?'Primeiros 30':results.length} resultado${results.length===1?'':'s'} · clique para ver o dia`:'Nenhum compromisso encontrado.');
    }catch(error){if(version===searchVersion)showSearchResults([],`Não foi possível buscar: ${error.message}`);}
  },150);
}
$('#search').oninput=searchAppointments;
$('#search').onfocus=()=>{if($('#search').value.trim())searchAppointments();};
$('#search').onkeydown=event=>{
  if(event.key==='Escape'){closeSearchResults();event.stopPropagation();}
  if((event.key==='ArrowDown'||event.key==='Enter')&&!$('#search-results').hidden){
    const first=$('#search-results').querySelector('button');
    if(first){event.preventDefault();if(event.key==='Enter')first.click();else first.focus();}
  }
};
$('#search-results').onkeydown=event=>{if(event.key==='Escape'){closeSearchResults();$('#search').focus();closeSearchResults();event.stopPropagation();}};
document.addEventListener('click',event=>{if(!event.target.closest('.search-box'))closeSearchResults();});
$('#clear-filter').onclick=()=>{filter='';renderFilters();renderCalendar();};
$('#notes').oninput=()=>{
  const key=currentNoteKey(), content=$('#notes').value;
  if (content === (savedNotes.get(key) || '')) noteDrafts.delete(key);
  else noteDrafts.set(key,content);
  updateNoteStatus();
  if(noteScope==='day')updateDayNoteMarker(noteDay);
};
$('#save-notes').onclick=()=>saveNotes();
$('#notes').addEventListener('keydown',event=>{
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault();saveNotes();}
});
$('#notes-month').onclick=()=>{noteScope='month';renderNotes();};
$('#notes-day').onclick=()=>{noteScope='day';renderNotes();};
$('#add-day-event').onclick=()=>openEvent(null,noteDay);
$('#quick-note').onclick=()=>{
  $('#notes-panel').scrollIntoView({behavior:'smooth',block:'nearest'});
  $('#notes').focus({preventScroll:true});
};
window.addEventListener('beforeunload',e=>{if(notesDirty){e.preventDefault();e.returnValue='';}});
for(const [nav,panel] of [['calendar-nav','.planner'],['tasks-nav','#tasks-panel'],['notes-nav','#notes-panel']]){
  $(`#${nav}`).onclick=()=>{document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));$(`#${nav}`).classList.add('active');$(panel).scrollIntoView({behavior:'smooth',block:'center'});$(panel).classList.remove('highlight');requestAnimationFrame(()=>$(panel).classList.add('highlight'));if(nav==='notes-nav')$('#notes').focus({preventScroll:true});};
}
function updateRecurrence(){
  const form=$('#event-form'),repeating=form.elements.recurrence.value!=='none';
  const byCount=form.elements.repeatEnd.value==='count';
  $('#repeat-end-label').hidden=!repeating;
  $('#repeat-count-label').hidden=!repeating||!byCount;form.elements.repeatCount.required=repeating&&byCount;
  $('#until-label').hidden=!repeating||byCount;form.elements.until.required=repeating&&!byCount;
  form.elements.repeatCount.disabled=!repeating||!byCount;
  form.elements.until.disabled=!repeating||byCount;
  form.elements.until.min=form.elements.date.value;$('#series-hint').hidden=!repeating;
}
function createNoteMarker(key){
  const button=element('button','note-marker');
  const text=noteContent(key).trim();
  button.append(element('strong','note-marker-label','✎ Nota'),element('span','note-marker-preview',text));
  button.title=text;
  button.setAttribute('aria-label',`Abrir anotação de ${key.split('-').reverse().join('/')}: ${text}`);
  button.onclick=()=>selectNoteDay(key);
  return button;
}
function updateDayNoteMarker(key){
  const cell=document.querySelector(`[data-date="${key}"]`);if(!cell)return;
  const marker=cell.querySelector('.note-marker');
  if(!noteContent(key).trim()){marker?.remove();return;}
  const button=createNoteMarker(key);
  if(marker)marker.replaceWith(button);else cell.insertBefore(button,cell.children[2]||null);
}
$('#event-form').elements.recurrence.onchange=updateRecurrence;
$('#event-form').elements.repeatEnd.onchange=updateRecurrence;
$('#event-form').elements.date.onchange=updateRecurrence;
async function flushNotes(){for(const key of noteDrafts.keys())if(!await saveNotes(key))return false;return true;}
async function refreshAll(){
  await Promise.all([loadMonth(),api('/tasks').then(data=>{tasks=data;renderTasks();})]);
  const history=await api('/history?undoable=1');lastHistoryId=history[0]?.id||null;$('#undo-last').disabled=!lastHistoryId;
}
async function initialize(){
  try{await refreshAll();}
  catch(error){toast(error.message);}
}
async function movePeriod(direction){
  if(calendarView==='month')return navigate(new Date(selected.getFullYear(),selected.getMonth()+direction,1));
  if(!await flushNotes())return;
  const date=new Date(`${noteDay}T12:00:00`);date.setDate(date.getDate()+direction*(calendarView==='week'?7:1));
  noteDay=localDate(date);await navigate(new Date(date.getFullYear(),date.getMonth(),1));
}
function setView(view){calendarView=view;renderCalendar();}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>setView(button.dataset.view));
async function undoAction(id){
  if(!await flushNotes())return;
  try{
    try{await api(`/history/${id}/undo`,{method:'POST',body:{}});}
    catch(error){if(!error.conflicts||!confirm('Desfazer causa um conflito de horário. Continuar mesmo assim?'))throw error;await api(`/history/${id}/undo`,{method:'POST',body:{allowConflict:true}});}
    $('#toast').hidden=true;await refreshAll();toast('Ação desfeita.');
    if($('#history-dialog').open)await loadHistory(true);
  }catch(error){toast(error.message);}
}
$('#undo-last').onclick=async()=>{
  try{const items=await api('/history?undoable=1');if(items.length)await undoAction(items[0].id);else toast('Não há alterações para desfazer.');}
  catch(error){toast(error.message);}
};
async function openHistory(note=null){
  historyMode='history';historyNote=note;historyOffset=0;
  if(!$('#history-dialog').open)$('#history-dialog').showModal();
  await loadHistory(true);
}
async function restoreItem(item){
  if(!await flushNotes())return;
  try{
    let result;
    try{result=await api(`/trash/${item.entity}/${item.id}/restore`,{method:'POST',body:{}});}
    catch(error){if(!error.conflicts||!confirm('Há conflito de horário. Restaurar mesmo assim?'))throw error;result=await api(`/trash/${item.entity}/${item.id}/restore`,{method:'POST',body:{allowConflict:true}});}
    await refreshAll();await loadHistory(true);toast('Item restaurado.',result.historyId);
  }catch(error){$('#history-error').textContent=error.message;}
}
async function restoreVersion(item){
  if(!confirm('Restaurar esta versão da anotação? O texto atual ficará disponível no histórico.'))return;
  if(!await flushNotes())return;
  try{const result=await api(`/history/${item.id}/version`,{method:'POST',body:{}});await refreshAll();await loadHistory(true);toast('Versão restaurada.',result.historyId);}
  catch(error){$('#history-error').textContent=error.message;}
}
async function loadHistory(reset=false){
  if(reset){historyOffset=0;$('#history-list').replaceChildren();}
  $('#history-error').textContent='';$('#history-more').disabled=true;
  $('#history-tab').setAttribute('aria-pressed',String(historyMode==='history'));$('#trash-tab').setAttribute('aria-pressed',String(historyMode==='trash'));
  $('#history-title').textContent=historyNote?'Versões da anotação':'Histórico e lixeira';
  $('#history-description').textContent=historyNote?`Anotações de ${historyNote.split('-').reverse().join('/')} · versões salvas no banco.`:historyMode==='trash'?'Itens excluídos podem ser restaurados.':'Ações mais recentes primeiro. Alterações posteriores precisam ser desfeitas antes das anteriores.';
  try{
    const items=await api(historyMode==='trash'?'/trash':`/history?offset=${historyOffset}${historyNote?`&note=${historyNote}`:''}`);
    if(!items.length&&historyOffset===0)$('#history-list').append(element('p','empty-message',historyMode==='trash'?'A lixeira está vazia.':'Nenhuma alteração registrada.'));
    const actions={create:'Criado',update:'Alterado',delete:'Movido para a lixeira',restore:'Restaurado',undo:'Ação desfeita'};
    const types={event:'Compromisso',task:'Tarefa',note:'Anotação'};
    items.forEach(item=>{
      const row=element('article','history-row');row.append(element('strong','',item.label||item.title));
      row.append(element('small','',`${types[item.entity]} · ${historyMode==='trash'?'Excluído':actions[item.action]} · ${new Date(item.created_at||item.deleted_at).toLocaleString('pt-BR')}`));
      if(item.entity==='note'){
        const details=element('details','version-preview');details.append(element('summary','','Visualizar versão'),element('pre','',item.after?.content||'(Anotação vazia)'));row.append(details);
      }else if(item.before&&item.after&&item.action==='update'){
        const changes=['title','date','start','end','completed','recurrence','until'].filter(key=>item.before[key]!==item.after[key]);
        const names={title:'Título',date:'Data',start:'Início',end:'Término',completed:'Conclusão',recurrence:'Repetição',until:'Fim da repetição'};
        const details=element('details','version-preview');details.append(element('summary','','Ver alterações'));
        for(const key of changes)details.append(element('p','',`${names[key]}: ${item.before[key]} → ${item.after[key]}`));row.append(details);
      }
      const buttons=element('div','history-actions');
      if(historyMode==='trash'){const button=element('button','secondary','Restaurar');button.onclick=()=>restoreItem(item);buttons.append(button);}
      else{
        if(item.reversible&&!item.undone){const button=element('button','secondary','Desfazer');button.onclick=()=>undoAction(item.id);buttons.append(button);}
        if(item.undone)buttons.append(element('span','history-undone','Já desfeita'));
        if(item.entity==='note'&&item.after){const button=element('button','text-button','Restaurar esta versão');button.onclick=()=>restoreVersion(item);buttons.append(button);}
      }
      row.append(buttons);$('#history-list').append(row);
    });
    $('#history-more').hidden=historyMode==='trash'||items.length<30;historyOffset+=items.length;
  }catch(error){$('#history-error').textContent=error.message;}finally{$('#history-more').disabled=false;}
}
$('#history-nav').onclick=()=>openHistory();$('#note-versions').onclick=()=>openHistory(currentNoteKey());
$('#history-tab').onclick=()=>{historyMode='history';loadHistory(true);};
$('#trash-tab').onclick=()=>{historyMode='trash';historyNote=null;loadHistory(true);};
$('#history-more').onclick=()=>loadHistory();$('#close-history').onclick=()=>$('#history-dialog').close();
$('#shortcuts-nav').onclick=()=>$('#shortcuts-dialog').showModal();$('#close-shortcuts').onclick=()=>$('#shortcuts-dialog').close();
document.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]')||event.target.closest('input,textarea,select,[contenteditable=true]'))return;
  if(event.altKey&&event.key.toLowerCase()==='z'){event.preventDefault();$('#undo-last').click();return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  const key=event.key.toLowerCase();
  if(key==='n'){event.preventDefault();openEvent();}
  else if(key==='/'){event.preventDefault();$('#search').focus();}
  else if(['m','s','d'].includes(key)){event.preventDefault();setView({m:'month',s:'week',d:'day'}[key]);}
});
await initialize();
