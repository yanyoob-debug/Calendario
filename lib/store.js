import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path) {
  if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);
  if(path!==':memory:' && db.prepare('PRAGMA user_version').get().user_version<2 && db.prepare("SELECT name FROM sqlite_master WHERE name='events'").get()) db.prepare('VACUUM INTO ?').run(`${path}.before-v2-${Date.now()}.bak`);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,demo INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',date TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,category TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,title TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS notes(month TEXT PRIMARY KEY,content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS day_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL);`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const table of ['events','tasks']) {
      const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
      if(!columns.has('user_id'))db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0`);
      if(!columns.has('deleted_at'))db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
      if(table==='events') {
        if(!columns.has('recurrence'))db.exec("ALTER TABLE events ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'");
        if(!columns.has('until'))db.exec("ALTER TABLE events ADD COLUMN until TEXT NOT NULL DEFAULT ''");
      }
    }
    for(const [table,key] of [['notes','month'],['day_notes','date']]) {
      if(!db.prepare(`PRAGMA table_info(${table})`).all().some(row=>row.name==='user_id')) {
        db.exec(`CREATE TABLE ${table}_v2(user_id INTEGER NOT NULL,${key} TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(user_id,${key}));
          INSERT INTO ${table}_v2 SELECT 0,${key},content FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v2 RENAME TO ${table};`);
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,entity TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,label TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL,undone INTEGER NOT NULL DEFAULT 0,reversible INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS events_owner_date ON events(user_id,deleted_at,date);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,deleted_at);
      CREATE INDEX IF NOT EXISTS history_owner ON history(user_id,id DESC);
      CREATE INDEX IF NOT EXISTS history_item ON history(user_id,entity,entity_id,id DESC);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
      PRAGMA user_version=2; COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error;}
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const record=(user,entity,id,action,before,after,label,reversible=1)=>{
    const result=db.prepare('INSERT INTO history(user_id,entity,entity_id,action,label,before_json,after_json,created_at,reversible) VALUES(?,?,?,?,?,?,?,?,?)').run(user,entity,String(id),action,label,before?JSON.stringify(before):null,after?JSON.stringify(after):null,new Date().toISOString(),reversible);
    return Number(result.lastInsertRowid);
  };
  const getItem=(user,entity,id)=>{
    if(entity==='event'||entity==='task')return db.prepare(`SELECT * FROM ${entity==='event'?'events':'tasks'} WHERE user_id=? AND id=?`).get(user,Number(id))||null;
    const daily=String(id).length===10;
    return db.prepare(`SELECT content FROM ${daily?'day_notes':'notes'} WHERE user_id=? AND ${daily?'date':'month'}=?`).get(user,id)||null;
  };
  const setNote=(user,key,content)=>{
    const daily=key.length===10,table=daily?'day_notes':'notes',column=daily?'date':'month';
    if(content===null)db.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${column}=?`).run(user,key);
    else db.prepare(`INSERT INTO ${table}(user_id,${column},content) VALUES(?,?,?) ON CONFLICT(user_id,${column}) DO UPDATE SET content=excluded.content`).run(user,key,content);
  };
  function undo(user,historyId) {
    return transaction(()=>{
      const item=db.prepare('SELECT * FROM history WHERE id=? AND user_id=? AND reversible=1 AND undone=0').get(historyId,user);
      if(!item)throw Error('Esta alteração não está disponível para desfazer.');
      const current=getItem(user,item.entity,item.entity_id), before=JSON.parse(item.before_json||'null'), after=JSON.parse(item.after_json||'null');
      if(JSON.stringify(current)!==JSON.stringify(after))throw Error('O item foi alterado depois desta ação. Desfaça a alteração mais recente primeiro.');
      if(item.entity==='note')setNote(user,item.entity_id,before?.content??null);
      else {
        const table=item.entity==='event'?'events':'tasks';
        if(!before)db.prepare(`UPDATE ${table} SET deleted_at=? WHERE id=? AND user_id=?`).run(new Date().toISOString(),Number(item.entity_id),user);
        else {
          const fields=Object.keys(before).filter(key=>key!=='id'&&key!=='user_id');
          db.prepare(`UPDATE ${table} SET ${fields.map(key=>`"${key}"=?`).join(',')} WHERE id=? AND user_id=?`).run(...fields.map(key=>before[key]),Number(item.entity_id),user);
        }
      }
      db.prepare('UPDATE history SET undone=1 WHERE id=?').run(item.id);
      record(user,item.entity,item.entity_id,'undo',current,getItem(user,item.entity,item.entity_id),item.label,0);
      return {ok:true};
    });
  }
  return {db,transaction,record,getItem,setNote,undo};
}
