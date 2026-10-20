import { openStore } from '../lib/store.js';
import { occurrences } from '../lib/calendar.js';
const {db,transaction}=openStore(':memory:');
const insert=db.prepare("INSERT INTO events(user_id,title,date,start,end,category,recurrence,\"until\") VALUES(1,?,?, '09:00','10:00','pessoal','none','')");
transaction(()=>{for(let i=0;i<10000;i++){const date=new Date(Date.UTC(2026,0,1+(i%1825),12)).toISOString().slice(0,10);insert.run(`Compromisso ${i}`,date);}});
const baseline=db.prepare("SELECT * FROM events WHERE user_id=1 AND deleted_at IS NULL AND substr(date,1,7)='2028-10'");
const indexed=db.prepare("SELECT * FROM events WHERE user_id=1 AND deleted_at IS NULL AND date BETWEEN '2028-10-01' AND '2028-10-31'");
const production=db.prepare('SELECT * FROM events WHERE user_id=? AND deleted_at IS NULL AND date<=? AND (date>=? OR "until">=?)');
function measure(fn){for(let i=0;i<10;i++)fn();const values=[];for(let i=0;i<100;i++){const start=performance.now();fn();values.push(performance.now()-start);}values.sort((a,b)=>a-b);return {medianMs:Number(values[50].toFixed(3)),p95Ms:Number(values[95].toFixed(3))};}
const report={node:process.version,records:10000,iterations:100,substringFilter:measure(()=>baseline.all()),indexedRange:measure(()=>indexed.all()),productionRangeWithExpansion:measure(()=>production.all(1,'2028-11-06','2028-09-25','2028-09-25').flatMap(event=>occurrences(event,'2028-09-25','2028-11-06'))),note:'Benchmark em memória, sem rede, autenticação ou renderização; resultados variam por máquina.'};
console.log(JSON.stringify(report,null,2));db.close();
