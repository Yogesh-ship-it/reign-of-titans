const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
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
    version:5,
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
    defenseRegenAt:Object.fromEntries(kingdoms.map(k=>[k.id,Date.now()+60*60*1000])),
    matchUsage:{windowStart:Math.floor(Date.now()/3600000)*3600000,counts:{}}
  };
}
function load(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const parsed=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
      if([3,4,5].includes(parsed.version) && Array.isArray(parsed.territories) && parsed.territories.length===105){
        let changed=false;
        if(parsed.version===3){
          // v3 stored accumulated unanswered counts; v4+ stores remaining Defense Points.
          const old=parsed.defensePoints||{};
          parsed.defensePoints=Object.fromEntries(kingdoms.map(k=>{const n=Number(old[k.id]);return [k.id,Number.isFinite(n)?Math.max(0,Math.min(3,3-n)):3]}));
          parsed.version=4;changed=true;
        }
        if(parsed.version===4){parsed.version=5;changed=true;}
        if(!parsed.defensePoints || typeof parsed.defensePoints!=="object"){
          parsed.defensePoints=Object.fromEntries(kingdoms.map(k=>[k.id,3]));changed=true;
        }
        if(!parsed.defenseRegenAt || typeof parsed.defenseRegenAt!=="object"){
          parsed.defenseRegenAt=Object.fromEntries(kingdoms.map(k=>[k.id,Date.now()+60*60*1000]));changed=true;
        }
        kingdoms.forEach(k=>{
          if(!Number.isFinite(Number(parsed.defensePoints[k.id]))){parsed.defensePoints[k.id]=3;changed=true;}
          if(!Number.isFinite(Number(parsed.defenseRegenAt[k.id]))){parsed.defenseRegenAt[k.id]=Date.now()+60*60*1000;changed=true;}
        });
        if(changed)save(parsed);
        return parsed;
      }
    }
  }catch(e){console.error("Data load:",e)}
  const s=blankState(); save(s); return s;
}
function ensureStateShape(){
  state.defensePoints=state.defensePoints||{};
  state.defenseRegenAt=state.defenseRegenAt||{};
  kingdoms.forEach(k=>{
    if(!Number.isFinite(state.defensePoints[k.id])) state.defensePoints[k.id]=3;
    state.defensePoints[k.id]=Math.max(0,Math.min(3,Math.round(state.defensePoints[k.id])));
    if(!Number.isFinite(Number(state.defenseRegenAt[k.id]))) state.defenseRegenAt[k.id]=Date.now()+60*60*1000;
  });
  if(!state.matchUsage || typeof state.matchUsage!="object") state.matchUsage={windowStart:Math.floor(Date.now()/3600000)*3600000,counts:{}};
  if(!state.matchUsage.counts || typeof state.matchUsage.counts!="object") state.matchUsage.counts={};
  ensureMatchUsageWindow();
}
function ensureMatchUsageWindow(){
  const currentWindow=Math.floor(Date.now()/3600000)*3600000;
  if(!state.matchUsage || state.matchUsage.windowStart!==currentWindow){
    state.matchUsage={windowStart:currentWindow,counts:{}};
    return true;
  }
  return false;
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
  return {...publicPlayer(p),gmail:p.gmail||""};
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
    defenseRegenAt:state.defenseRegenAt,
    matchUsage:{windowStart:state.matchUsage.windowStart,resetAt:state.matchUsage.windowStart+3600000}
  };
}
function adminState(){
  return {
    ...publicState(),
    players:Object.fromEntries(Object.entries(state.players).map(([id,p])=>[id,privatePlayer(p)])),
    completedBattles:state.completedBattles || [],
    matchUsage:{windowStart:state.matchUsage.windowStart,resetAt:state.matchUsage.windowStart+3600000,counts:state.matchUsage.counts}
  };
}
function socketIdsForPlayer(playerId){
  return [...io.sockets.sockets.values()].filter(s=>s.data.playerId===playerId).map(s=>s.id)
}
function emitPlayer(playerId,event,payload){
  for(const sid of socketIdsForPlayer(playerId))io.to(sid).emit(event,payload)
}
function notifyKingdom(kid,event,payload){
  Object.values(state.players).filter(p=>p.kingdom===kid).forEach(p=>emitPlayer(p.id,event,payload))
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
  for(const p of Object.values(state.players)) emitPlayer(p.id,"myMatchUsage",{used:Number(state.matchUsage.counts[p.id]||0),resetAt:state.matchUsage.windowStart+3600000});
}
function slotFor(kid){
  const used=Object.values(state.players).filter(p=>p.kingdom===kid).length;
  return used<3?used+1:null;
}
function labelFor(kid,slot){return `${K(kid).name} ${String.fromCharCode(64+slot)}`}
function activeChallengeForTerritory(tid){
  return Object.values(state.challenges).find(c=>c.territoryId===tid&&c.status!=="resolved")
}
const MATCH_STATUSES=new Set(["accepted","ready","reported","disputed"]);
function playerInMatch(playerId,exceptChallengeId=null){
  return Object.values(state.challenges).some(c=>c.id!==exceptChallengeId&&MATCH_STATUSES.has(c.status)&&(c.attackerId===playerId||c.defenderId===playerId));
}
function regenerateDefensePoints(now=Date.now()){
  let changed=false;
  for(const kingdom of kingdoms){
    const kid=kingdom.id;
    const points=Math.max(0,Math.min(3,Number(state.defensePoints[kid]??3)));
    let due=Number(state.defenseRegenAt[kid]||0);
    if(!due){due=now+60*60*1000;state.defenseRegenAt[kid]=due;changed=true;continue;}
    if(now<due)continue;
    if(points>=3){state.defenseRegenAt[kid]=now+60*60*1000;changed=true;continue;}
    const elapsedHours=Math.floor((now-due)/(60*60*1000))+1;
    const gained=Math.min(3-points,elapsedHours);
    state.defensePoints[kid]=points+gained;
    state.defenseRegenAt[kid]=state.defensePoints[kid]>=3?now+60*60*1000:due+gained*60*60*1000;
    changed=true;
  }
  return changed;
}
function resolve(chId,winnerId,reason){
  const ch=state.challenges[chId],winner=state.players[winnerId];
  if(!ch||!winner)return;
  const t=state.territories.find(x=>x.id===ch.territoryId);
  if(!t)return;
  const old=t.kingdom;
  const loserId=winnerId===ch.attackerId?ch.defenderId:ch.attackerId;
  winner.wins++;
  if(loserId&&state.players[loserId])state.players[loserId].losses++;
  t.kingdom=winner.kingdom;
  ch.status="resolved";ch.winnerId=winnerId;ch.resolutionReason=reason;ch.resolvedAt=Date.now();
  const completed={...ch,territory:{...t},winner:publicPlayer(winner),reports:state.reports[chId]||{},completedAt:Date.now()};
  state.completedBattles=state.completedBattles||[];
  state.completedBattles.unshift(completed);
  state.completedBattles=state.completedBattles.slice(0,200);
  addNotice(`${winner.riot||winner.name||winner.label} captured Territory ${t.num} of ${K(old).name}.`);
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
  const a=r[ch.attackerId],d=r[ch.defenderId];
  if(a&&d&&a.winnerId!==d.winnerId){
    ch.status="disputed";
    ch.disputedAt=Date.now();
    emitAdmins("battleDisputed",ch);
    broadcast();
    return;
  }
  // Matching reports still go through the normal 5-minute admin review window.
  // The first submitted winner is auto-confirmed only when that window expires.
}
setInterval(()=>{
  const now=Date.now();
  const defenseChanged=regenerateDefensePoints(now);
  const usageChanged=ensureMatchUsageWindow();
  if(defenseChanged||usageChanged)broadcast();
  for(const ch of Object.values(state.challenges)){
    if(ch.status==="pending"&&now>=ch.expiresAt)expirePendingChallenge(ch.id);
    if(ch.status==="accepted"&&ch.checkinExpiresAt&&now>=ch.checkinExpiresAt)expireCheckin(ch.id);
    if(ch.status==="reported"){
      const entries=Object.values(state.reports[ch.id]||{});
      if(entries.length===1){
        const first=entries[0];
        if(now>=first.time+5*60*1000&&first.winnerId)resolve(ch.id,first.winnerId,"Five-minute admin window expired; reported winner automatically confirmed.");
      }
    }
  }
},1000);

app.use(express.json());
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.use(express.static(path.join(__dirname,"public")));

io.on("connection",socket=>{
  socket.on("resume",id=>{
    if(state.players[id]){socket.data.playerId=id;socket.emit("registered",{player:publicPlayer(state.players[id]),state:publicState()});socket.emit("myMatchUsage",{used:Number(state.matchUsage.counts[id]||0),resetAt:state.matchUsage.windowStart+3600000})}
    else socket.emit("resumeFailed")
  });

  socket.on("register",(d,cb)=>{
    const riot=String(d?.riot||"").trim(),discord=String(d?.discord||"").trim();
    if(!riot||!discord)return cb?.({ok:false,error:"Enter both your in-game name and Discord ID."});
    const norm=v=>String(v||"").trim().toLowerCase();
    const existing=Object.values(state.players).find(p=>norm(p.riot)===norm(riot)&&norm(p.discord)===norm(discord));
    if(existing){socket.data.playerId=existing.id;socket.emit("registered",{player:publicPlayer(existing),state:publicState()});socket.emit("myMatchUsage",{used:Number(state.matchUsage.counts[existing.id]||0),resetAt:state.matchUsage.windowStart+3600000});return cb?.({ok:true,player:publicPlayer(existing),state:publicState(),existing:true});}
    const id=crypto.randomUUID();
    state.players[id]={id,name:riot,gmail:"",riot,discord,kingdom:null,slot:null,label:"Awaiting Kingdom Assignment",wins:0,losses:0,registeredAt:Date.now()};
    state.playerOrder.push(id);socket.data.playerId=id;save(state);
    cb?.({ok:true,player:publicPlayer(state.players[id]),state:publicState(),existing:false});socket.emit("myMatchUsage",{used:Number(state.matchUsage.counts[id]||0),resetAt:state.matchUsage.windowStart+3600000});
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
    delete state.matchUsage.counts[playerId];delete state.players[playerId];state.playerOrder=state.playerOrder.filter(id=>id!==playerId);
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
    if(ensureMatchUsageWindow())broadcast();
    const attacker=state.players[socket.data.playerId],t=state.territories.find(x=>x.id===tid);
    if(!attacker||!t)return cb?.({ok:false,error:"Invalid player or territory."});
    if(!attacker.kingdom)return cb?.({ok:false,error:"Your Kingdom has not been assigned by the admin yet."});
    if(playerInMatch(attacker.id))return cb?.({ok:false,error:"You are already in a match and cannot start another challenge."});
    if(t.kingdom===attacker.kingdom)return cb?.({ok:false,error:"You cannot attack your own Kingdom."});
    if(activeChallengeForTerritory(tid))return cb?.({ok:false,error:"That territory is already under challenge."});
    const used=Number(state.matchUsage.counts[attacker.id]||0);
    if(used>=3)return cb?.({ok:false,error:"You have used all 3 matches for this hour. Your match limit resets at the next hour."});
    const ch={id:crypto.randomUUID(),territoryId:tid,attackerId:attacker.id,defenderKingdom:t.kingdom,defenderId:null,status:"pending",
      createdAt:Date.now(),expiresAt:Date.now()+15*60*1000,checkins:{},chat:[]};
    state.matchUsage.counts[attacker.id]=used+1;
    state.challenges[ch.id]=ch;addNotice(`${attacker.riot||attacker.name||attacker.label} challenged Territory ${t.num} of ${K(t.kingdom).name}.`,t.kingdom);
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
  socket.on("challengeAccept",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch)return cb?.({ok:false,error:"Challenge not found."});
    if(ch.status!=="pending")return cb?.({ok:false,error:"This challenge is no longer waiting for acceptance."});
    if(Date.now()>=Number(ch.expiresAt||0)){expirePendingChallenge(id);return cb?.({ok:false,error:"The 15-minute challenge window has expired."});}
    if(p.kingdom!==ch.defenderKingdom)return cb?.({ok:false,error:"Only a player from the defending Kingdom can accept."});
    if(playerInMatch(p.id))return cb?.({ok:false,error:"You are already in a match and cannot accept another challenge."});
    if(playerInMatch(ch.attackerId))return cb?.({ok:false,error:"The challenger is already in another match. This challenge is no longer available."});
    // A player cannot carry an old outgoing challenge into a new active match.
    for(const other of Object.values(state.challenges)){
      if(other.id!==id&&other.status==="pending"&&other.attackerId===p.id){
        delete state.challenges[other.id];delete state.reports[other.id];
        io.emit("challengeCancelled",{challengeId:other.id,territoryId:other.territoryId,reason:"Challenger entered another match."});
      }
    }
    const acceptedAt=Date.now();
    ch.defenderId=p.id;ch.status="accepted";ch.acceptedAt=acceptedAt;ch.checkinExpiresAt=acceptedAt+5*60*1000;ch.checkins=ch.checkins||{};
    addNotice(`${p.riot||p.name||p.label} accepted a territory challenge.`);
    emitAdmins("challengeAcceptedAdmin",{challenge:ch,defender:publicPlayer(p)});
    broadcast();io.emit("challengeAccepted",ch);io.emit("challengeUpdated",ch);cb?.({ok:true,challenge:ch});
  });
  socket.on("challengeDecline",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch)return cb?.({ok:false,error:"Challenge not found or it has already been handled."});
    if(ch.status!=="pending")return cb?.({ok:false,error:"This challenge is no longer waiting for a decision."});
    if(p.kingdom!==ch.defenderKingdom)return cb?.({ok:false,error:"Only a player from the defending Kingdom can decline."});
    if(playerInMatch(p.id))return cb?.({ok:false,error:"You are already in a match and cannot respond to another challenge."});
    if(Date.now()>=Number(ch.expiresAt||0)){expirePendingChallenge(id);return cb?.({ok:false,error:"The 15-minute challenge window has expired."});}
    const kid=ch.defenderKingdom;
    const pointsBefore=Math.max(0,Number(state.defensePoints[kid]??3));
    state.defensePoints[kid]=Math.max(0,pointsBefore-1);
    if(pointsBefore>0)state.defenseRegenAt[kid]=Date.now()+60*60*1000;
    const territory=state.territories.find(t=>t.id===ch.territoryId);
    const result={challengeId:id,territoryId:ch.territoryId,defenderKingdom:kid,defensePoints:state.defensePoints[kid],declinedBy:publicPlayer(p)};
    delete state.challenges[id];delete state.reports[id];
    addNotice(`${p.riot||p.name||p.label} declined the challenge. ${K(kid).name} lost 1 Defense Point.`,kid);
    io.emit("challengeDeclined",result);
    state.adminEvents=state.adminEvents||[];state.adminEvents.unshift({time:Date.now(),action:"challengeDeclined",challengeId:id,territoryId:ch.territoryId,kingdomId:kid,declinedBy:p.id,defensePoints:state.defensePoints[kid]});state.adminEvents=state.adminEvents.slice(0,200);
    emitAdmins("challengeDeclinedAdmin",{...result,territory,defenderKingdom:K(kid)});
    broadcast();cb?.({ok:true,defensePoints:state.defensePoints[kid]});
  });
  socket.on("checkin",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||![ch.attackerId,ch.defenderId].includes(p.id))return cb?.({ok:false,error:"You are not part of this battle."});
    if(ch.status!=="accepted")return cb?.({ok:false,error:ch.status==="ready"?"Both players have already checked in.":"Check-in is not open for this challenge."});
    if(ch.checkinExpiresAt&&Date.now()>=ch.checkinExpiresAt){expireCheckin(id);return cb?.({ok:false,error:"The five-minute check-in window has expired."});}
    ch.checkins=ch.checkins||{};ch.checkins[p.id]=Date.now();
    if(ch.checkins[ch.attackerId]&&ch.checkins[ch.defenderId]){ch.status="ready";ch.readyAt=Date.now();}
    broadcast();io.emit("challengeUpdated",ch);cb?.({ok:true,challenge:ch});
  });
  socket.on("reportResult",(id,result,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||!ch.defenderId)return cb?.({ok:false,error:"Battle is not accepted yet."});
    if(!ch.checkins[ch.attackerId]||!ch.checkins[ch.defenderId])return cb?.({ok:false,error:"Both players must check in first."});
    if(!["win","loss"].includes(result))return cb?.({ok:false,error:"Invalid result."});
    state.reports[id]=state.reports[id]||{};
    if(state.reports[id][p.id])return cb?.({ok:false,error:"You already reported your result."});
    const winnerId=result==="win"?p.id:(p.id===ch.attackerId?ch.defenderId:ch.attackerId);
    state.reports[id][p.id]={result,winnerId,time:Date.now()};
    ch.status="reported";ch.firstReportAt=ch.firstReportAt||Date.now();
    io.emit("resultReported",{challenge:ch,reports:state.reports[id]});
    emitAdmins("resultReportedAdmin",{challenge:ch,reports:state.reports[id]});
    evaluate(id);broadcast();cb?.({ok:true});
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
});

app.get("/api/health",(req,res)=>res.json({ok:true,version:3}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`Kingdom Conquest running on http://localhost:${PORT}`));
