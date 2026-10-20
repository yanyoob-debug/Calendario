import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
export const tokenHash=token=>createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex'), hash=await scrypt(password,salt,64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password,stored) {
  const [salt,hash]=stored.split(':');
  const derived=await scrypt(password,salt||'invalid',64);
  const expected=Buffer.from(hash||'00'.repeat(64),'hex');
  return derived.length===expected.length && timingSafeEqual(derived,expected);
}
export function authStore(db) {
  const session=req=>{
    const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('florir_session='))?.slice(15);
    if(!token || !/^[a-f0-9]{64}$/.test(token))return null;
    return db.prepare('SELECT users.id,users.name,users.email,users.demo FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires_at>?').get(tokenHash(token),Date.now())||null;
  };
  const issue=(res,user)=>{
    const token=randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token),user,Date.now()+8*3600000);
    res.setHeader('Set-Cookie',`florir_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);
  };
  const logout=(req,res)=>{
    const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('florir_session='))?.slice(15);
    if(token)db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(token));
    res.setHeader('Set-Cookie','florir_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  };
  return {session,issue,logout};
}
