const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
const json=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"Content-Type":"application/json",...cors}});
const uid=()=>crypto.randomUUID(), enc=new TextEncoder();
const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const toB64=a=>btoa(String.fromCharCode(...new Uint8Array(a)));
async function auth(r,e){return !!e.APP_TOKEN&&(r.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"")===e.APP_TOKEN}
async function publisherAuth(r,e){return !!e.PUBLISHER_TOKEN&&(r.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"")===e.PUBLISHER_TOKEN}
async function aesKey(e){return crypto.subtle.importKey("raw",b64(e.TOKEN_ENCRYPTION_KEY),"AES-GCM",false,["encrypt","decrypt"])}
async function encrypt(s,e){const iv=crypto.getRandomValues(new Uint8Array(12));const c=await crypto.subtle.encrypt({name:"AES-GCM",iv},await aesKey(e),enc.encode(s));return {cipher:toB64(c),iv:toB64(iv)}}
async function decrypt(row,e){const p=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64(row.refresh_iv)},await aesKey(e),b64(row.refresh_cipher));return new TextDecoder().decode(p)}
async function mac(s,e){const k=await crypto.subtle.importKey("raw",enc.encode(e.MEDIA_SIGNING_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return toB64(await crypto.subtle.sign("HMAC",k,enc.encode(s)))}
async function mediaUrl(key,e,ttl=3600){const exp=Math.floor(Date.now()/1000)+ttl;return `${e.WORKER_ORIGIN}/__media_proxy?key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(await mac(`${key}:${exp}`,e))}`}
async function dispatch(e,w,inputs){const u=`https://api.github.com/repos/${e.GITHUB_OWNER}/${e.GITHUB_REPO}/actions/workflows/${w}/dispatches`;const r=await fetch(u,{method:"POST",headers:{"Authorization":`Bearer ${e.GITHUB_TOKEN}`,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},body:JSON.stringify({ref:"main",inputs})});if(!r.ok)throw Error(`GitHub workflow dispatch ${r.status}: ${await r.text()}`)}
async function job(e,id){return e.DB.prepare("SELECT jobs.*,channels.name AS channel_name FROM jobs JOIN channels ON channels.id=jobs.channel_id WHERE jobs.id=?").bind(id).first()}
async function audit(e,id,a,d=""){await e.DB.prepare("INSERT INTO audit_log(job_id,action,details) VALUES(?,?,?)").bind(id,a,d).run()}
async function accessToken(e,channel){const row=await e.DB.prepare("SELECT * FROM channel_tokens WHERE channel_id=?").bind(channel).first();if(!row)throw Error("YouTube channel is not connected");const refresh=await decrypt(row,e);const f=new URLSearchParams({client_id:e.GOOGLE_CLIENT_ID,client_secret:e.GOOGLE_CLIENT_SECRET,refresh_token:refresh,grant_type:"refresh_token"});const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:f});const x=await r.json();if(!r.ok||!x.access_token)throw Error("Google refresh failed: "+(x.error_description||x.error));return x.access_token}
export default {async fetch(req,e){
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 const u=new URL(req.url),p=u.pathname;
 try{
  // Signed R2 read URLs are time-limited and key-specific.
  if(req.method==="GET"&&p==="/__media_proxy"){
   const k=u.searchParams.get("key")||"",exp=Number(u.searchParams.get("exp")),sig=u.searchParams.get("sig")||"";
   if(!k||!Number.isFinite(exp)||exp<Math.floor(Date.now()/1000)||sig!==await mac(`${k}:${exp}`,e))return new Response("Forbidden",{status:403});
   const o=await e.MEDIA.get(k);return o?new Response(o.body,{headers:{"Content-Type":o.httpMetadata?.contentType||"application/octet-stream","Cache-Control":"private,max-age=180"}}):new Response("Not found",{status:404});
  }
  // Google redirects here after one-time state validation.
  if(req.method==="GET"&&p==="/oauth/callback"){
   const code=u.searchParams.get("code"),state=u.searchParams.get("state");if(!code||!state)return new Response("OAuth cancelled or missing code/state",{status:400});
   const st=await e.DB.prepare("SELECT * FROM oauth_states WHERE state=?").bind(state).first();
   if(!st||st.expires_at<Math.floor(Date.now()/1000))return new Response("OAuth state expired. Reconnect from dashboard.",{status:400});
   await e.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
   const f=new URLSearchParams({code,client_id:e.GOOGLE_CLIENT_ID,client_secret:e.GOOGLE_CLIENT_SECRET,redirect_uri:e.GOOGLE_REDIRECT_URI,grant_type:"authorization_code"});
   const tr=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:f});const t=await tr.json();
   if(!tr.ok)return new Response("Google token exchange failed: "+(t.error_description||t.error),{status:400});
   let refresh=t.refresh_token;
   if(!refresh){const old=await e.DB.prepare("SELECT * FROM channel_tokens WHERE channel_id=?").bind(st.channel_id).first();if(old)refresh=await decrypt(old,e)}
   if(!refresh)return new Response("No refresh token returned. Reconnect and grant consent again.",{status:400});
   const z=await encrypt(refresh,e);
   await e.DB.prepare(`INSERT INTO channel_tokens(channel_id,refresh_cipher,refresh_iv,scope) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET refresh_cipher=excluded.refresh_cipher,refresh_iv=excluded.refresh_iv,scope=excluded.scope,token_updated_at=CURRENT_TIMESTAMP`).bind(st.channel_id,z.cipher,z.iv,t.scope||"").run();
   const cr=await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",{headers:{Authorization:`Bearer ${t.access_token}`}});const cd=await cr.json();
   if(cr.ok&&cd.items?.[0])await e.DB.prepare("UPDATE channels SET youtube_channel_id=?,name=? WHERE id=?").bind(cd.items[0].id,cd.items[0].snippet?.title||"YouTube channel",st.channel_id).run();
   return new Response("<html><body style='font:16px system-ui;padding:40px'><h2>YouTube connected successfully</h2><p>Return to your dashboard.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>",{headers:{"Content-Type":"text/html"}});
  }
  if(p.startsWith("/api/publish/")){if(!await publisherAuth(req,e))return json({error:"Publisher unauthorized"},401)}
  else if(!await auth(req,e))return json({error:"Unauthorized"},401);
  if(req.method==="GET"&&p==="/api/health")return json({ok:true});
  if(req.method==="GET"&&p==="/api/channels"){
   const q=await e.DB.prepare("SELECT * FROM channels ORDER BY created_at DESC").all();
   return json(await Promise.all(q.results.map(async c=>({...c,connected:!!await e.DB.prepare("SELECT channel_id FROM channel_tokens WHERE channel_id=?").bind(c.id).first()}))));
  }
  if(req.method==="POST"&&p==="/api/channels"){
   const b=await req.json();if(!b.name?.trim())return json({error:"Channel name required"},400);
   const id=uid();await e.DB.prepare("INSERT INTO channels(id,name,niche,default_language) VALUES(?,?,?,?)").bind(id,b.name.trim(),b.niche||"",b.default_language||"en").run();return json({id,ok:true},201);
  }
  if(req.method==="POST"&&p==="/api/oauth/url"){
   const b=await req.json(),c=await e.DB.prepare("SELECT id FROM channels WHERE id=? AND active=1").bind(b.channel_id).first();if(!c)return json({error:"Channel not found"},404);
   const state=uid()+uid();await e.DB.prepare("INSERT INTO oauth_states(state,channel_id,expires_at) VALUES(?,?,?)").bind(state,b.channel_id,Math.floor(Date.now()/1000)+600).run();
   const q=new URLSearchParams({client_id:e.GOOGLE_CLIENT_ID,redirect_uri:e.GOOGLE_REDIRECT_URI,response_type:"code",scope:"https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube",access_type:"offline",prompt:"consent",include_granted_scopes:"true",state});
   return json({url:"https://accounts.google.com/o/oauth2/v2/auth?"+q.toString()});
  }
  if(req.method==="GET"&&p==="/api/jobs"){
   const q=await e.DB.prepare("SELECT jobs.*,channels.name AS channel_name FROM jobs JOIN channels ON channels.id=jobs.channel_id ORDER BY jobs.created_at DESC LIMIT 100").all();
   return json(await Promise.all(q.results.map(async j=>({...j,media_url:j.media_key?await mediaUrl(j.media_key,e):null,thumbnail_url:j.thumbnail_key?await mediaUrl(j.thumbnail_key,e):null}))));
  }
  if(req.method==="POST"&&p==="/api/jobs"){
   const b=await req.json();if(!b.channel_id||!b.topic?.trim())return json({error:"Channel and topic required"},400);if(!["en","hi","mr"].includes(b.language))return json({error:"Language must be en, hi or mr"},400);
   const id=uid(),fmt=b.format==="long"?"long":"short",mins=Math.max(1,Math.min(8,Number(b.target_minutes)||1));
   await e.DB.prepare("INSERT INTO jobs(id,channel_id,topic,language,format,target_minutes,status) VALUES(?,?,?,?,?,?,'queued')").bind(id,b.channel_id,b.topic.trim(),b.language,fmt,mins).run();
   await dispatch(e,"render.yml",{job_id:id,topic:b.topic.trim(),language:b.language,format:fmt,minutes:String(mins)});
   await e.DB.prepare("UPDATE jobs SET status='rendering',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();await audit(e,id,"created");return json({id,status:"rendering"},201);
  }
  const scene=p.match(/^\/api\/jobs\/([^/]+)\/scene$/);
  if(req.method==="POST"&&scene){
   const b=await req.json();if(!b.prompt)return json({error:"Prompt required"},400);
   const result=await e.AI.run("@cf/black-forest-labs/flux-1-schnell",{prompt:String(b.prompt).slice(0,1800),steps:4});
   if(!result?.image)return json({error:"FLUX did not return an image"},502);
   const raw=atob(result.image),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
   const key=`jobs/${scene[1]}/scene-${String(b.index||1).padStart(2,"0")}.jpg`;await e.MEDIA.put(key,bytes,{httpMetadata:{contentType:"image/jpeg"}});
   return json({key,url:await mediaUrl(key,e)});
  }
  const reject=p.match(/^\/api\/jobs\/([^/]+)\/reject$/);
  if(req.method==="POST"&&reject){const id=reject[1],j=await job(e,id);if(!j||!["ready","rendering"].includes(j.status))return json({error:"Job cannot be rejected"},409);await e.DB.prepare("UPDATE jobs SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();await audit(e,id,"rejected");return json({ok:true})}
  const meta=p.match(/^\/api\/jobs\/([^/]+)\/metadata$/);
  if(req.method==="POST"&&meta){const b=await req.json();await e.DB.prepare("UPDATE jobs SET title=?,description=?,script=?,tags=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.title||"",b.description||"",b.script||"",JSON.stringify(b.tags||[]),meta[1]).run();return json({ok:true})}
  const failed=p.match(/^\/api\/jobs\/([^/]+)\/failed$/);
  if(req.method==="POST"&&failed){const b=await req.json().catch(()=>({}));await e.DB.prepare("UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(b.error||"Render failed").slice(0,1000),failed[1]).run();await audit(e,failed[1],"render_failed");return json({ok:true})}
  const media=p.match(/^\/api\/jobs\/([^/]+)\/media$/);
  if(req.method==="PUT"&&media){
   const j=await job(e,media[1]);if(!j)return json({error:"Job not found"},404);
   if(Number(req.headers.get("Content-Length")||0)>95*1024*1024)return json({error:"Video exceeds 95 MB safety cap"},413);
   const key=`jobs/${media[1]}/video.mp4`;await e.MEDIA.put(key,req.body,{httpMetadata:{contentType:"video/mp4"}});
   await e.DB.prepare("UPDATE jobs SET media_key=?,status='ready',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(key,media[1]).run();await audit(e,media[1],"render_ready");return json({ok:true});
  }
  const thumb=p.match(/^\/api\/jobs\/([^/]+)\/thumbnail$/);
  if(req.method==="PUT"&&thumb){const key=`jobs/${thumb[1]}/thumbnail.jpg`;await e.MEDIA.put(key,req.body,{httpMetadata:{contentType:"image/jpeg"}});await e.DB.prepare("UPDATE jobs SET thumbnail_key=? WHERE id=?").bind(key,thumb[1]).run();return json({ok:true})}
  const approve=p.match(/^\/api\/jobs\/([^/]+)\/approve$/);
  if(req.method==="POST"&&approve){
   const id=approve[1],j=await job(e,id);if(!j||j.status!=="ready"||!j.media_key)return json({error:"Only completed videos can be approved"},409);
   if(!await e.DB.prepare("SELECT channel_id FROM channel_tokens WHERE channel_id=?").bind(j.channel_id).first())return json({error:"Connect YouTube first"},409);
   await e.DB.prepare("UPDATE jobs SET status='approved',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();try{await dispatch(e,"publish.yml",{job_id:id})}catch(ex){await e.DB.prepare("UPDATE jobs SET status='ready',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(ex.message).slice(0,900),id).run();throw ex}await audit(e,id,"approved_for_private_upload");return json({ok:true,status:"approved"});
  }
  const getpub=p.match(/^\/api\/publish\/([^/]+)$/);
  if(req.method==="GET"&&getpub){
   const j=await job(e,getpub[1]);if(!j||j.status!=="approved")return json({error:"Job is not approved"},409);
   return json({access_token:await accessToken(e,j.channel_id),media_url:await mediaUrl(j.media_key,e,1800),thumbnail_url:j.thumbnail_key?await mediaUrl(j.thumbnail_key,e,1800):null,title:j.title||j.topic,description:j.description||"",tags:j.tags?JSON.parse(j.tags):[],language:j.language});
  }
  const done=p.match(/^\/api\/publish\/([^/]+)\/done$/);
  if(req.method==="POST"&&done){
   const b=await req.json();if(!b.video_id)return json({error:"video_id required"},400);const id=done[1],j=await job(e,id);if(!j)return json({error:"Job not found"},404);if(j.status==="uploaded_private"&&j.youtube_video_id===b.video_id)return json({ok:true,idempotent:true});if(j.status!=="approved")return json({error:"Job not approved"},409);
   await e.DB.prepare("UPDATE jobs SET youtube_video_id=?,youtube_url=?,status='uploaded_private',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.video_id,`https://www.youtube.com/watch?v=${b.video_id}`,id).run();await audit(e,id,"uploaded_private",b.video_id);return json({ok:true});
  }
  const pubfail=p.match(/^\/api\/publish\/([^/]+)\/failed$/);
  if(req.method==="POST"&&pubfail){const b=await req.json().catch(()=>({}));await e.DB.prepare("UPDATE jobs SET status='ready',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='approved'").bind(String(b.error||"Upload failed").slice(0,900),pubfail[1]).run();await audit(e,pubfail[1],"upload_failed");return json({ok:true})}
  const pub=p.match(/^\/api\/jobs\/([^/]+)\/publish$/);
  if(req.method==="POST"&&pub){
   const id=pub[1],j=await job(e,id);if(!j||j.status!=="uploaded_private"||!j.youtube_video_id)return json({error:"Only private uploads can be published"},409);
   const token=await accessToken(e,j.channel_id);
   const r=await fetch("https://www.googleapis.com/youtube/v3/videos?part=status",{method:"PUT",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({id:j.youtube_video_id,status:{privacyStatus:"public"}})});
   const d=await r.json();if(!r.ok)return json({error:d.error?.message||"YouTube publish failed"},502);
   await e.DB.prepare("UPDATE jobs SET status='published',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();await audit(e,id,"published_public");return json({ok:true,status:"published",youtube_url:j.youtube_url});
  }
  return json({error:"Not found"},404);
 }catch(err){return json({error:err.message||"Internal error"},500)}
}};
