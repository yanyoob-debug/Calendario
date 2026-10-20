import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { openStore } from '../lib/store.js';

test('migração preserva dados antigos, cria backup e é idempotente',()=>{
  const directory=mkdtempSync(join(tmpdir(),'florir-migration-')),path=join(directory,'agenda.sqlite');
  let legacy=new DatabaseSync(path),migrated;
  try{
    legacy.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',date TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,category TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
      INSERT INTO events(title,date,start,end,category) VALUES('Preservar compromisso','2026-10-20','09:00','10:00','pessoal');
      CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
      INSERT INTO tasks(title) VALUES('Preservar tarefa');
      CREATE TABLE notes(month TEXT PRIMARY KEY,content TEXT NOT NULL); INSERT INTO notes VALUES('2026-10','Preservar anotação');
      CREATE TABLE day_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL); INSERT INTO day_notes VALUES('2026-10-20','Preservar anotação diária');`);
    legacy.close();legacy=null;
    migrated=openStore(path);
    assert.equal(migrated.db.prepare('SELECT title FROM events WHERE user_id=0').get().title,'Preservar compromisso');
    assert.equal(migrated.getItem(0,'note','2026-10').content,'Preservar anotação');
    assert.equal(migrated.getItem(0,'note','2026-10-20').content,'Preservar anotação diária');
    assert.equal(readdirSync(directory).filter(name=>name.endsWith('.bak')).length,1);
    migrated.db.close();migrated=openStore(path);
    assert.equal(migrated.db.prepare('SELECT count(*) AS total FROM tasks').get().total,1);
    assert.equal(readdirSync(directory).filter(name=>name.endsWith('.bak')).length,1);
  }finally{
    legacy?.close();migrated?.db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('florir-migration-'));
    rmSync(directory,{recursive:true,force:true});
  }
});
