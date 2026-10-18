const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID || "kamleshhhh";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kamlesh078";
const DATA_FILE = path.join(__dirname, "data.json");

const kingdoms = [
  {id:"verdant",name:"Verdant Reach",color:"#35a85b",icon:"♧"},
  {id:"frost",name:"Frosthold",color:"#4b9de8",icon:"❄"},
  {id:"stone",name:"Stoneheart",color:"#9a9a9a",icon:"⬟"},
  {id:"sky",name:"Skyharbor",color:"#26a9c7",icon:"♆"},
  {id:"sun",name:"Sunspire",color:"#e6ad2e",icon:"☀"},
  {id:"ember",name:"Emberfall",color:"#e34a24",icon:"🔥"},
  {id:"shadow",name:"Shadowvale",color:"#8c4bd6",icon:"☾"}
];

const zones = [
  {id:"frost",x:[30,47],y:[13,38]}, {id:"sky",x:[52,70],y:[11,37]},
  {id:"ember",x:[7,26],y:[27,48]}, {id:"shadow",x:[75,92],y:[14,39]},
  {id:"iron",x:[7,28],y:[48,70]}, {id:"storm",x:[73,93],y:[42,65]},
  {id:"blood",x:[8,29],y:[70,94]}, {id:"tide",x:[73,94],y:[69,94]},
  {id:"verdant",x:[35,52],y:[70,94]}, {id:"sun",x:[55,72],y:[68,94]}
];

function blankState(){
  const territories=[];
  kingdoms.forEach(k=>{
    for(let i=1;i<=15;i++) territories.push({id:`${k.id}-${i}`,num:i,kingdom:k.id,originalKingdom:k.id});
  });
  return {
    version:4,
    tournamentStartedAt:null,
    players:{},
    playerOrder:[],
    territories,
    challenges:{},
    reports:{},
    notifications:[],
    adminEvents:[],
    completedBattles:[],
    defensePoints:Object.fromEntries(kingdoms.map(k=>[k.id,3])),
    matchUsage:{players:{}},lastDefenseRegenAt:Date.now(),lastOpponentByAttackingKingdom:{}
  };
}
function load(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const parsed=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
      if((parsed.version>=3) && Array.isArray(parsed.territories) && parsed.territories.length===105){
        if(parsed.version===3){
          // v3 used 0/1/2 as accumulated unanswered counts. v4 uses 2/1/0 defense points.
          const old=parsed.defensePoints||{};
          parsed.defensePoints=Object.fromEntries(kingdoms.map(k=>{const n=Number(old[k.id]);return [k.id,Number.isFinite(n)?Math.max(0,Math.min(3,3-n)):3]}));
          parsed.version=4;
          save(parsed);
        }
        return parsed
      };
    }
  }catch(e){console.error("Data load:",e)}
  const s=blankState(); save(s); return s;
}
function ensureStateShape(){
  state.defensePoints=state.defensePoints||{};
  kingdoms.forEach(k=>{ if(!Number.isFinite(state.defensePoints[k.id])) state.defensePoints[k.id]=3; state.defensePoints[k.id]=Math.max(0,Math.min(3,Math.round(state.defensePoints[k.id]))); });
  if(!state.matchUsage || typeof state.matchUsage!=="object") state.matchUsage={players:{}};
  // Migrate older shared-hour counters to personal rolling two-hour windows.
  if(!state.matchUsage.players || typeof state.matchUsage.players!=="object"){
    const old=state.matchUsage.counts||{};
    state.matchUsage={players:{}};
    for(const [pid,used] of Object.entries(old)) state.matchUsage.players[pid]={used:Number(used)||0,windowStart:null,resetAt:null};
  }
  if(!Number.isFinite(state.lastDefenseRegenAt)) state.lastDefenseRegenAt=Date.now();
  if(!state.lastOpponentByAttackingKingdom || typeof state.lastOpponentByAttackingKingdom!=="object") state.lastOpponentByAttackingKingdom={};
}
function usageFor(playerId){
  const now=Date.now();
  let u=state.matchUsage.players[playerId];
  if(!u || typeof u!=="object") u=state.matchUsage.players[playerId]={used:0,windowStart:null,resetAt:null};
  if(u.resetAt && now>=u.resetAt) { u.used=0;u.windowStart=null;u.resetAt=null; }
  u.used=Math.max(0,Math.min(3,Number(u.used)||0));
  return u;
}
function publicUsage(playerId){const u=usageFor(playerId);return {used:u.used,windowStart:u.windowStart||null,resetAt:u.resetAt||null,limit:3,periodMs:2*60*60*1000};}
function canStartMatch(playerId){return usageFor(playerId).used<3;}
function startMatchUsage(playerIds){
  const now=Date.now();
  for(const pid of playerIds){
    const u=usageFor(pid);
    if(u.used>=3)return {ok:false,playerId:pid};
  }
  for(const pid of playerIds){const u=usageFor(pid);if(!u.windowStart){u.windowStart=now;u.resetAt=now+2*60*60*1000;}u.used+=1;}
  return {ok:true};
}
function regenerateDefensePoints(){
  const now=Date.now(),hours=Math.floor((now-state.lastDefenseRegenAt)/3600000);
  if(hours<=0)return false;
  for(const k of kingdoms)state.defensePoints[k.id]=Math.min(3,Math.max(0,Number(state.defensePoints[k.id]??3))+hours);
  state.lastDefenseRegenAt+=hours*3600000;
  return true;
}

function save(s){fs.writeFileSync(DATA_FILE,JSON.stringify(s,null,2))}
let state=load();
ensureStateShape();

function K(id){return kingdoms.find(k=>k.id===id)}
function publicPlayer(p){
  if(!p)return null;
  return {id:p.id,name:p.name,riot:p.riot,discord:p.discord,kingdom:p.kingdom,slot:p.slot,label:p.label,wins:p.wins,losses:p.losses,status:p.kingdom?"Assigned":"Awaiting Kingdom"};
}
function privatePlayer(p){
  if(!p)return null;
  return {...publicPlayer(p),gmail:p.gmail||"",lastIpAddress:p.lastIpAddress||"Not recorded",lastSeenAt:p.lastSeenAt||null,lastConnectedAt:p.lastConnectedAt||null,connectionCount:Number(p.connectionCount||0),registeredAt:p.registeredAt||null,ipLocation:p.ipLocation||null};
}
function publicState(){
  return {
    tournamentStartedAt:state.tournamentStartedAt,
    players:Object.fromEntries(Object.entries(state.players).map(([id,p])=>[id,publicPlayer(p)])),
    playerOrder:state.playerOrder,
    territories:state.territories,
    challenges:state.challenges,
    reports:state.reports,
    notifications:state.notifications.slice(0,100),
    kingdoms,
    defensePoints:state.defensePoints,
    matchUsage:{periodMs:7200000}
  };
}
function adminState(){
  return {
    ...publicState(),
    players:Object.fromEntries(Object.entries(state.players).map(([id,p])=>[id,privatePlayer(p)])),
    completedBattles:state.completedBattles || [],
    matchUsage:{periodMs:7200000,players:state.matchUsage.players}
  };
}
function socketIdsForPlayer(playerId){
  return [...io.sockets.sockets.values()].filter(s=>s.data.playerId===playerId).map(s=>s.id)
}
function emitPlayer(playerId,event,payload){
  for(const sid of socketIdsForPlayer(playerId))io.to(sid).emit(event,payload)
}
function playerInMatch(playerId){
  return Object.values(state.challenges).some(ch=>[ch.attackerId,ch.defenderId].includes(playerId)&&["accepted","ready","reported","disputed"].includes(ch.status));
}
function notifyKingdom(kid,event,payload){
  Object.values(state.players).filter(p=>p.kingdom===kid && !(event==="challengeIncoming"&&playerInMatch(p.id))).forEach(p=>emitPlayer(p.id,event,payload))
}
function emitAdmins(event,payload){
  for(const s of io.sockets.sockets.values()) if(s.data.isAdmin) s.emit(event,payload)
}
function addNotice(message,kingdomId=null){
  const n={id:crypto.randomUUID(),message,kingdomId,time:Date.now()};
  state.notifications.unshift(n);state.notifications=state.notifications.slice(0,100);
  if(kingdomId)notifyKingdom(kingdomId,"battleAlert",n);
}
function broadcast(){
  save(state);io.emit("state",publicState());
  // Match counts are private to each player; only send each player their own usage.
  for(const p of Object.values(state.players)) emitPlayer(p.id,"myMatchUsage",publicUsage(p.id));
}
function slotFor(kid){
  const used=Object.values(state.players).filter(p=>p.kingdom===kid).length;
  return used<3?used+1:null;
}
function labelFor(kid,slot){return `${K(kid).name} ${String.fromCharCode(64+slot)}`}
function activeChallengeForTerritory(tid){
  return Object.values(state.challenges).find(c=>c.territoryId===tid&&c.status!=="resolved")
}
function resolve(chId,winnerId,reason){
  const ch=state.challenges[chId],winner=state.players[winnerId];
  if(!ch||!winner)return;
  const t=state.territories.find(x=>x.id===ch.territoryId);
  if(!t)return;
  const old=t.kingdom;
  const attackingKingdom=state.players[ch.attackerId]?.kingdom;
  if(attackingKingdom && ch.defenderKingdom) state.lastOpponentByAttackingKingdom[attackingKingdom]=ch.defenderKingdom;
  const loserId=winnerId===ch.attackerId?ch.defenderId:ch.attackerId;
  winner.wins++;
  if(loserId&&state.players[loserId])state.players[loserId].losses++;
  t.kingdom=winner.kingdom;
  ch.status="resolved";ch.winnerId=winnerId;ch.resolutionReason=reason;ch.resolvedAt=Date.now();
  const completed={...ch,territory:{...t},winner:publicPlayer(winner),reports:state.reports[chId]||{},completedAt:Date.now()};
  state.completedBattles=state.completedBattles||[];
  state.completedBattles.unshift(completed);
  state.completedBattles=state.completedBattles.slice(0,200);
  addNotice(`${winner.label} captured Territory ${t.num} of ${K(old).name}.`);
  emitAdmins("battleResolved",completed);
  io.emit("challengeResolved",{challenge:ch,territory:t,winner:publicPlayer(winner)});
  delete state.challenges[chId];delete state.reports[chId];
  broadcast();
}
function expirePendingChallenge(chId){
  const ch=state.challenges[chId];
  if(!ch||ch.status!=="pending")return;
  const attacker=state.players[ch.attackerId];
  if(!attacker){delete state.challenges[chId];delete state.reports[chId];broadcast();return;}
  ch.walkover=true;
  resolve(chId,attacker.id,"Victory by walkover: defender did not accept within 15 minutes.");
  emitPlayer(attacker.id,"walkover",{challengeId:chId,title:"VICTORY BY WALKOVER!",message:"Your opponent did not accept the challenge within 15 minutes."});
  if(ch.defenderKingdom)notifyKingdom(ch.defenderKingdom,"walkover",{challengeId:chId,title:"CHALLENGE EXPIRED",message:"The challenge expired because it was not accepted within 15 minutes."});
}
function expireCheckin(chId){
  const ch=state.challenges[chId];
  if(!ch||ch.status!=="accepted")return;
  const a=!!ch.checkins?.[ch.attackerId], d=!!ch.checkins?.[ch.defenderId];
  if(a&&d){ch.status="ready";broadcast();return;}
  if(a===d){
    const payload={challengeId:chId,title:"NO-SHOW",message:"Neither player checked in within five minutes. The match was recorded as a no-show."};
    [ch.attackerId,ch.defenderId].filter(Boolean).forEach(pid=>emitPlayer(pid,"walkover",payload));
    state.completedBattles=state.completedBattles||[];state.completedBattles.unshift({...ch,status:"no-show",resolutionReason:payload.message,completedAt:Date.now()});
    delete state.challenges[chId];delete state.reports[chId];broadcast();return;
  }
  const winnerId=a?ch.attackerId:ch.defenderId;
  const loserId=a?ch.defenderId:ch.attackerId;
  resolve(chId,winnerId,"Victory by walkover: opponent failed to check in within five minutes.");
  emitPlayer(winnerId,"walkover",{challengeId:chId,title:"VICTORY BY WALKOVER!",message:"Your opponent did not check in within five minutes."});
  if(loserId)emitPlayer(loserId,"walkover",{challengeId:chId,title:"DEFEAT BY WALKOVER",message:"You did not check in within five minutes."});
}

function evaluate(chId){
  const ch=state.challenges[chId],r=state.reports[chId]||{};
  if(!ch)return;
  const entries=Object.values(r);
  const a=r[ch.attackerId],d=r[ch.defenderId];
  if(a&&d){
    if(a.winnerId===d.winnerId){
      resolve(chId,a.winnerId,"Both players reported the same winner; result automatically confirmed.");
      return;
    }
    ch.status="disputed";
    ch.disputedAt=ch.disputedAt||Date.now();
    emitAdmins("battleDisputed",ch);
    io.emit("resultReported",{challenge:ch,reports:r});
    broadcast();
    return;
  }
  if(entries.length===1){
    ch.status="reported";
    if(!ch.firstReportAt) ch.firstReportAt=entries[0].time;
    if(!ch.resultDeadline) ch.resultDeadline=ch.firstReportAt+10*60*1000;
  }
  io.emit("resultReported",{challenge:ch,reports:r});
  emitAdmins("resultReportedAdmin",{challenge:ch,reports:r});
  broadcast();
}

setInterval(()=>{
  const now=Date.now();
  let changed=regenerateDefensePoints();
  for(const p of Object.values(state.players)) { const before=state.matchUsage.players[p.id]?.used; usageFor(p.id); if(before!==state.matchUsage.players[p.id]?.used) changed=true; }
  if(changed)broadcast();
  for(const ch of Object.values(state.challenges)){
    if(ch.status==="pending"&&now>=ch.expiresAt)expirePendingChallenge(ch.id);
    if(ch.status==="accepted"&&ch.checkinExpiresAt&&now>=ch.checkinExpiresAt)expireCheckin(ch.id);
    if(ch.status==="reported"){
      const entries=Object.values(state.reports[ch.id]||{});
      if(entries.length===1){
        const first=entries[0];
        const deadline=Number(ch.resultDeadline||first.time+10*60*1000);
        if(now>=deadline&&first.winnerId)resolve(ch.id,first.winnerId,"Opponent did not report a result within ten minutes; the submitted result was automatically confirmed.");
      }
    }
  }
},1000);

app.use(express.json());
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.use(express.static(path.join(__dirname,"public")));

function clientIp(socket){
  // Use proxy headers only when explicitly configured for a trusted reverse proxy.
  // Otherwise use the socket peer address to avoid trusting spoofed X-Forwarded-For values.
  if(process.env.TRUST_PROXY === "true"){
    const forwarded=String(socket.handshake.headers["x-forwarded-for"]||"").split(",")[0].trim();
    if(forwarded) return forwarded.slice(0,100);
  }
  return String(socket.handshake.address||"Unknown").replace(/^::ffff:/,"").slice(0,100);
}

const geoCache=new Map();
function isPublicIp(ip){
  if(!ip || ip==="Unknown" || ip==="127.0.0.1" || ip==="::1") return false;
  if(/^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}
function lookupIpLocation(ip){
  return new Promise(resolve=>{
    if(!isPublicIp(ip)) return resolve(null);
    if(geoCache.has(ip)) return resolve(geoCache.get(ip));
    const req=https.get(`https://ipapi.co/${encodeURIComponent(ip)}/json/`,{timeout:3500,headers:{"User-Agent":"ReignOfTitanTournament/1.0"}},res=>{
      let body="";
      res.on("data",chunk=>body+=chunk);
      res.on("end",()=>{
        try{
          const d=JSON.parse(body);
          const lat=Number(d.latitude),lon=Number(d.longitude);
          const result=(!d.error && Number.isFinite(lat) && Number.isFinite(lon))?{
            city:String(d.city||"").slice(0,100),
            region:String(d.region||"").slice(0,100),
            country:String(d.country_name||d.country||"").slice(0,100),
            latitude:lat,longitude:lon,
            source:"IP geolocation",
            updatedAt:Date.now()
          }:null;
          geoCache.set(ip,result);resolve(result);
        }catch{resolve(null)}
      });
    });
    req.on("timeout",()=>{req.destroy();resolve(null)});
    req.on("error",()=>resolve(null));
  });
}
async function updatePlayerGeo(playerId,ip){
  const p=state.players[playerId]; if(!p || !isPublicIp(ip)) return;
  const location=await lookupIpLocation(ip);
  if(!location || !state.players[playerId]) return;
  // Avoid applying a slow response to a newer connection from another IP.
  if(state.players[playerId].lastIpAddress!==ip) return;
  state.players[playerId].ipLocation=location;
  save(state);
  emitAdmins("playerConnectionUpdated",{playerId,ipLocation:location});
}

function touchPlayerConnection(playerId,socket){
  const p=state.players[playerId]; if(!p)return;
  p.lastIpAddress=clientIp(socket);
  p.lastSeenAt=Date.now();
  p.lastConnectedAt=Date.now();
  p.connectionCount=Math.max(0,Number(p.connectionCount||0))+1;
  save(state);
  updatePlayerGeo(playerId,p.lastIpAddress).catch(()=>{});
}

io.on("connection",socket=>{
  socket.on("resume",id=>{
    if(state.players[id]){socket.data.playerId=id;touchPlayerConnection(id,socket);socket.emit("registered",{player:publicPlayer(state.players[id]),state:publicState()});socket.emit("myMatchUsage",publicUsage(id))}
    else socket.emit("resumeFailed")
  });

  socket.on("register",(d,cb)=>{
    const riot=String(d?.riot||"").trim(),discord=String(d?.discord||"").trim();
    if(!riot||!discord)return cb?.({ok:false,error:"Enter both your in-game name and Discord ID."});
    const norm=v=>String(v||"").trim().toLowerCase();
    const existing=Object.values(state.players).find(p=>norm(p.riot)===norm(riot)&&norm(p.discord)===norm(discord));
    if(existing){socket.data.playerId=existing.id;touchPlayerConnection(existing.id,socket);socket.emit("registered",{player:publicPlayer(existing),state:publicState()});socket.emit("myMatchUsage",publicUsage(existing.id));return cb?.({ok:true,player:publicPlayer(existing),state:publicState(),existing:true});}
    const id=crypto.randomUUID();
    state.players[id]={id,name:riot,gmail:"",riot,discord,kingdom:null,slot:null,label:"Awaiting Kingdom Assignment",wins:0,losses:0,registeredAt:Date.now(),lastIpAddress:clientIp(socket),lastSeenAt:Date.now(),lastConnectedAt:Date.now(),connectionCount:1};
    state.playerOrder.push(id);socket.data.playerId=id;save(state);
    updatePlayerGeo(id,state.players[id].lastIpAddress).catch(()=>{});
    cb?.({ok:true,player:publicPlayer(state.players[id]),state:publicState(),existing:false});socket.emit("myMatchUsage",publicUsage(id));
    io.emit("playerRegistered",publicPlayer(state.players[id]));broadcast();
  });

  socket.on("adminLogin",(credentials,cb)=>{
    const id=typeof credentials==="object"?credentials.id:"";
    const password=typeof credentials==="object"?credentials.password:credentials;
    if(String(id)!==ADMIN_ID || String(password)!==ADMIN_PASSWORD)return cb?.({ok:false,error:"Incorrect Admin ID or password."});
    socket.data.isAdmin=true;cb?.({ok:true,state:adminState()});
  });
  socket.on("adminState",cb=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    cb?.({ok:true,state:adminState()});
  });
  socket.on("adminAssign",(playerId,kingdomId,cb)=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    const p=state.players[playerId],k=K(kingdomId);
    if(!p||!k)return cb?.({ok:false,error:"Player or Kingdom not found."});
    if(p.kingdom===kingdomId)return cb?.({ok:false,error:"Player is already assigned to this Kingdom."});
    if(slotFor(kingdomId)===null)return cb?.({ok:false,error:"That Kingdom already has 3 players."});
    // If reassigned, free the old slot naturally; labels of other players stay stable.
    const slot=slotFor(kingdomId);
    p.kingdom=kingdomId;p.slot=slot;p.label=labelFor(kingdomId,slot);
    state.adminEvents.unshift({time:Date.now(),action:"assign",playerId,kingdomId});
    addNotice(`${p.name} has been assigned to ${k.name}.`);
    broadcast();cb?.({ok:true,state:adminState()});
    emitPlayer(playerId,"assigned",publicPlayer(p));
  });
  socket.on("adminRemovePlayer",(playerId,cb)=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    const player=state.players[playerId];if(!player)return cb?.({ok:false,error:"Player not found."});
    for(const ch of Object.values(state.challenges))if(ch.attackerId===playerId||ch.defenderId===playerId){delete state.challenges[ch.id];delete state.reports[ch.id];io.emit("challengeCancelled",{challengeId:ch.id,territoryId:ch.territoryId});}
    delete state.matchUsage.players[playerId];delete state.players[playerId];state.playerOrder=state.playerOrder.filter(id=>id!==playerId);
    state.adminEvents.unshift({time:Date.now(),action:"removePlayer",playerId,label:player.label||player.name});state.adminEvents=state.adminEvents.slice(0,200);
    addNotice(`Admin removed ${player.label||player.name} from the active tournament.`);broadcast();cb?.({ok:true,state:adminState()});
  });
  socket.on("adminSetTerritoryOwner",(territoryId,kingdomId,cb)=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    const t=state.territories.find(x=>x.id===territoryId),k=K(kingdomId);
    if(!t||!k)return cb?.({ok:false,error:"Territory or Kingdom not found."});
    const previous=t.kingdom;
    t.kingdom=kingdomId;
    t.adminOverrideAt=Date.now();
    t.adminOverrideFrom=previous;
    state.adminEvents.unshift({time:Date.now(),action:"territoryOwnerOverride",territoryId,from:previous,to:kingdomId});
    state.adminEvents=state.adminEvents.slice(0,200);
    addNotice(`Admin changed Territory ${t.num} from ${K(previous)?.name||previous} to ${k.name}.`);
    broadcast();
    cb?.({ok:true,state:adminState(),territory:t});
  });
  socket.on("adminStartTournament",cb=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    if(Object.values(state.players).some(p=>!p.kingdom))return cb?.({ok:false,error:"Assign every registered player before starting."});
    state.tournamentStartedAt=Date.now();addNotice("The 48-hour Kingdom Conquest has begun.");broadcast();cb?.({ok:true});
  });
  socket.on("adminResetTournament",cb=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    state=blankState();save(state);io.emit("state",publicState());cb?.({ok:true});
  });

  socket.on("challengeCreate",(tid,cb)=>{
    if(regenerateDefensePoints())broadcast();
    const attacker=state.players[socket.data.playerId],t=state.territories.find(x=>x.id===tid);
    if(!attacker||!t)return cb?.({ok:false,error:"Invalid player or territory."});
    if(!attacker.kingdom)return cb?.({ok:false,error:"Your Kingdom has not been assigned by the admin yet."});
    if(playerInMatch(attacker.id))return cb?.({ok:false,error:"You are already in a match."});
    if(Object.values(state.challenges).some(other=>["accepted","ready","reported","disputed"].includes(other.status)&&(other.attackerKingdom===attacker.kingdom||other.defenderKingdom===attacker.kingdom)))return cb?.({ok:false,error:"Your Kingdom is already participating in another match."});
    if(t.kingdom===attacker.kingdom)return cb?.({ok:false,error:"You cannot attack your own Kingdom."});
    if(activeChallengeForTerritory(tid))return cb?.({ok:false,error:"That territory is already under challenge."});
    if(state.lastOpponentByAttackingKingdom[attacker.kingdom]===t.kingdom)return cb?.({ok:false,error:"Your Kingdom must complete a match against a different Kingdom before challenging this Kingdom again."});
    if(!canStartMatch(attacker.id))return cb?.({ok:false,error:"You have used all 3 matches in your personal two-hour period."});
    const ch={id:crypto.randomUUID(),territoryId:tid,attackerId:attacker.id,attackerKingdom:attacker.kingdom,defenderKingdom:t.kingdom,defenderId:null,status:"pending",
      createdAt:Date.now(),expiresAt:Date.now()+15*60*1000,checkins:{},chat:[]};
    state.challenges[ch.id]=ch;addNotice(`${attacker.label} challenged Territory ${t.num} of ${K(t.kingdom).name}.`,t.kingdom);
    emitAdmins("challengeRequest",{challenge:ch,attacker:publicPlayer(attacker),territory:t,defenderKingdom:K(t.kingdom)});
    notifyKingdom(t.kingdom,"challengeIncoming",{challenge:ch,attacker:publicPlayer(attacker),territory:t,defenderKingdom:K(t.kingdom)});
    broadcast();cb?.({ok:true,challenge:ch});
  });
  socket.on("challengeCancel",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch)return cb?.({ok:false,error:"Challenge not found."});
    if(ch.status!=="pending")return cb?.({ok:false,error:"Only a pending challenge can be cancelled."});
    if(ch.attackerId!==p.id)return cb?.({ok:false,error:"Only the attacking player can cancel this challenge."});
    const t=state.territories.find(x=>x.id===ch.territoryId);
    delete state.challenges[id];delete state.reports[id];
    addNotice(`${p.label} cancelled the challenge for Territory ${t?.num||"?"}.`);
    io.emit("challengeCancelled",{challengeId:id,territoryId:ch.territoryId});
    broadcast();cb?.({ok:true});
  });
  socket.on("challengeDecline",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||ch.status!=="pending")return cb?.({ok:false,error:"This challenge is no longer pending."});
    if(p.kingdom!==ch.defenderKingdom)return cb?.({ok:false,error:"Only a member of the defending Kingdom can decline."});
    const kid=ch.defenderKingdom;
    state.defensePoints[kid]=Math.max(0,Number(state.defensePoints[kid]??3)-1);
    const t=state.territories.find(x=>x.id===ch.territoryId);
    delete state.challenges[id];delete state.reports[id];
    addNotice(`${p.label} declined the challenge. ${K(kid).name} lost 1 Defense Point.`,kid);
    io.emit("challengeCancelled",{challengeId:id,territoryId:ch.territoryId,reason:"declined",declinedBy:p.id,defenderKingdom:kid});
    broadcast();cb?.({ok:true,defensePoints:state.defensePoints[kid]});
  });
  socket.on("challengeAccept",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch)return cb?.({ok:false,error:"Challenge not found."});
    if(ch.status!=="pending")return cb?.({ok:false,error:"This challenge is no longer waiting for acceptance."});
    if(p.kingdom!==ch.defenderKingdom)return cb?.({ok:false,error:"Only a player from the defending Kingdom can accept."});
    if(playerInMatch(p.id))return cb?.({ok:false,error:"You are already in a match."});
    if(Object.values(state.challenges).some(other=>other.id!==ch.id&&["accepted","ready","reported","disputed"].includes(other.status)&&(other.attackerKingdom===p.kingdom||other.defenderKingdom===p.kingdom)))return cb?.({ok:false,error:"Your Kingdom is already participating in another match."});
    if(playerInMatch(ch.attackerId))return cb?.({ok:false,error:"The challenger is already in a match."});
    if(Object.values(state.challenges).some(other=>other.id!==ch.id&&["accepted","ready","reported","disputed"].includes(other.status)&&(other.attackerKingdom===ch.attackerKingdom||other.defenderKingdom===ch.attackerKingdom)))return cb?.({ok:false,error:"The challenger's Kingdom is already participating in another match."});
    if(!canStartMatch(ch.attackerId))return cb?.({ok:false,error:"The challenger has reached their personal match limit."});
    if(!canStartMatch(p.id))return cb?.({ok:false,error:"You have reached your personal match limit for this two-hour period."});
    ch.defenderId=p.id;ch.status="accepted";ch.acceptedAt=Date.now();ch.checkinExpiresAt=Date.now()+5*60*1000;
    addNotice(`${p.label} accepted a territory challenge.`);
    emitAdmins("challengeAcceptedAdmin",{challenge:ch,defender:publicPlayer(p)});
    broadcast();io.emit("challengeAccepted",ch);cb?.({ok:true,challenge:ch});
  });
  socket.on("checkin",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||![ch.attackerId,ch.defenderId].includes(p.id))return cb?.({ok:false,error:"You are not part of this battle."});
    if(ch.status!=="accepted"&&ch.status!=="ready")return cb?.({ok:false,error:"Check-in is not open for this challenge."});
    if(ch.checkinExpiresAt&&Date.now()>ch.checkinExpiresAt)return cb?.({ok:false,error:"The five-minute check-in window has expired."});
    if(ch.checkins[p.id])return cb?.({ok:true,alreadyCheckedIn:true});
    ch.checkins[p.id]=Date.now();
    if(ch.checkins[ch.attackerId]&&ch.checkins[ch.defenderId]){
      const usage=startMatchUsage([ch.attackerId,ch.defenderId]);
      if(!usage.ok){delete ch.checkins[p.id];return cb?.({ok:false,error:"A player has reached their personal match limit. The match cannot start."});}
      ch.status="ready";ch.matchStartedAt=Date.now();
      addNotice(`${state.players[ch.attackerId]?.label||"Attacker"} and ${state.players[ch.defenderId]?.label||"Defender"} both checked in. Match started.`);
    }
    broadcast();io.emit("challengeUpdated",ch);cb?.({ok:true,matchStarted:ch.status==="ready"});
  });
  socket.on("reportResult",(id,result,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||!ch.defenderId)return cb?.({ok:false,error:"Battle is not accepted yet."});
    if(!ch.checkins[ch.attackerId]||!ch.checkins[ch.defenderId])return cb?.({ok:false,error:"Both players must check in first."});
    if(!["win","loss"].includes(result))return cb?.({ok:false,error:"Invalid result."});
    if(!["ready","reported","disputed"].includes(ch.status))return cb?.({ok:false,error:"This result can no longer be changed."});
    state.reports[id]=state.reports[id]||{};
    const now=Date.now();
    const existing=state.reports[id][p.id];
    // If the only report's 10-minute deadline has already passed, finalize it before accepting a late response.
    const currentEntries=Object.entries(state.reports[id]);
    if(ch.status==="reported"&&currentEntries.length===1&&currentEntries[0][0]!==p.id&&now>=Number(ch.resultDeadline||currentEntries[0][1].time+10*60*1000)){
      resolve(id,currentEntries[0][1].winnerId,"Opponent did not report a result within ten minutes; the submitted result was automatically confirmed.");
      return cb?.({ok:false,error:"The reporting deadline expired and the other player's result was already finalized."});
    }
    const winnerId=result==="win"?p.id:(p.id===ch.attackerId?ch.defenderId:ch.attackerId);
    state.reports[id][p.id]={result,winnerId,time:now,updated:!!existing};
    if(ch.status!=="disputed")ch.status="reported";
    if(!ch.firstReportAt)ch.firstReportAt=now;
    if(Object.keys(state.reports[id]).length===1&&!ch.resultDeadline)ch.resultDeadline=now+10*60*1000;
    evaluate(id);broadcast();cb?.({ok:true,updated:!!existing});
  });
  socket.on("chat",(id,message,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||![ch.attackerId,ch.defenderId].includes(p.id))return cb?.({ok:false,error:"Chat is limited to battle participants."});
    const text=String(message||"").trim().slice(0,500);if(!text)return;
    const msg={id:crypto.randomUUID(),playerId:p.id,label:p.label,text,time:Date.now()};
    ch.chat=ch.chat||[];ch.chat.push(msg);ch.chat=ch.chat.slice(-100);
    [ch.attackerId,ch.defenderId].forEach(pid=>emitPlayer(pid,"chatMessage",{challengeId:id,message:msg}));
    save(state);cb?.({ok:true});
  });
  socket.on("adminResolve",(id,winnerId,cb)=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    const ch=state.challenges[id];
    if(!ch||!["reported","disputed"].includes(ch.status))return cb?.({ok:false,error:"This battle is not awaiting an admin decision."});
    if(![ch.attackerId,ch.defenderId].includes(winnerId))return cb?.({ok:false,error:"Winner must be one of the two players."});
    resolve(id,winnerId,"Admin approved the result.");
    cb?.({ok:true});
  });
  socket.on("adminDenyReport",(id,playerId,cb)=>{
    if(!socket.data.isAdmin)return cb?.({ok:false,error:"Admin authentication required."});
    const ch=state.challenges[id],r=state.reports[id]||{};
    if(!ch||!["reported","disputed"].includes(ch.status))return cb?.({ok:false,error:"This battle is not awaiting an admin decision."});
    if(!r[playerId])return cb?.({ok:false,error:"That player has not submitted a result."});
    delete r[playerId];
    if(Object.keys(r).length===0){ch.status="ready";delete state.reports[id];}
    else {ch.status="reported";ch.firstReportAt=Object.values(r).sort((a,b)=>a.time-b.time)[0].time;}
    addNotice(`Admin denied a result report for ${ch.id}.`);
    emitAdmins("reportDenied",{challenge:ch,playerId});
    broadcast();cb?.({ok:true});
  });

  socket.on("disconnect",()=>{
    const playerId=socket.data.playerId;
    if(playerId && state.players[playerId]){
      state.players[playerId].lastSeenAt=Date.now();
      save(state);
      emitAdmins("playerConnectionUpdated",{playerId,lastSeenAt:state.players[playerId].lastSeenAt});
    }
  });
});

app.get("/api/health",(req,res)=>res.json({ok:true,version:2}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`Kingdom Conquest running on http://localhost:${PORT}`));
