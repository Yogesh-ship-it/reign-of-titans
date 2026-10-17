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
    defensePoints:Object.fromEntries(kingdoms.map(k=>[k.id,3]))
  };
}
function load(){
  try{
    if(fs.existsSync(DATA_FILE)){
      const parsed=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
      if((parsed.version===3 || parsed.version===4) && Array.isArray(parsed.territories) && parsed.territories.length===105){
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
}

function save(s){fs.writeFileSync(DATA_FILE,JSON.stringify(s,null,2))}
let state=load();
ensureStateShape();

function K(id){return kingdoms.find(k=>k.id===id)}
function publicPlayer(p){
  if(!p)return null;
  return {id:p.id,name:p.name,kingdom:p.kingdom,slot:p.slot,label:p.label,wins:p.wins,losses:p.losses,status:p.kingdom?"Assigned":"Awaiting Kingdom"};
}
function privatePlayer(p){
  if(!p)return null;
  return {...publicPlayer(p),gmail:p.gmail,riot:p.riot,discord:p.discord};
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
    defensePoints:state.defensePoints
  };
}
function adminState(){
  return {
    ...publicState(),
    players:Object.fromEntries(Object.entries(state.players).map(([id,p])=>[id,privatePlayer(p)])),
    completedBattles:state.completedBattles || []
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
function broadcast(){save(state);io.emit("state",publicState())}
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
  const t=state.territories.find(x=>x.id===ch.territoryId);
  const attacker=state.players[ch.attackerId];
  if(!t||!attacker){delete state.challenges[chId];broadcast();return;}
  const defendingKingdom=ch.defenderKingdom;
  const current=Math.max(0,Math.min(3,Number(state.defensePoints[defendingKingdom] ?? 3)));
  if(current===0){
    const old=t.kingdom;
    t.kingdom=attacker.kingdom;
    // Fourth unanswered challenge gives the challenger the free win and resets defense to 3.
    state.defensePoints[defendingKingdom]=3;
    ch.status="resolved";ch.winnerId=attacker.id;ch.resolutionReason="Third unanswered challenge: territory forfeited by Defense Point rule.";ch.resolvedAt=Date.now();
    const completed={...ch,territory:{...t},winner:publicPlayer(attacker),reports:{},completedAt:Date.now()};
    state.completedBattles=state.completedBattles||[];state.completedBattles.unshift(completed);state.completedBattles=state.completedBattles.slice(0,200);
    addNotice(`${K(old).name} reached 0 Defense Points. Territory ${t.num} was forfeited to ${K(attacker.kingdom).name}; Defense Points reset to 3.`);
    emitAdmins("battleResolved",completed);io.emit("challengeResolved",{challenge:ch,territory:t,winner:publicPlayer(attacker)});
  }else{
    state.defensePoints[defendingKingdom]=current-1;
    addNotice(`${K(defendingKingdom).name} did not accept within 4 hours. Defense Points: ${state.defensePoints[defendingKingdom]}.`,defendingKingdom);
    emitAdmins("challengeExpired",{challenge:ch,defensePoints:state.defensePoints[defendingKingdom]});
  }
  delete state.challenges[chId];delete state.reports[chId];broadcast();
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
  for(const ch of Object.values(state.challenges)){
    if(ch.status==="pending"&&now>=ch.expiresAt)expirePendingChallenge(ch.id);
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
    if(state.players[id]){socket.data.playerId=id;socket.emit("registered",{player:publicPlayer(state.players[id]),state:publicState()})}
    else socket.emit("resumeFailed")
  });

  socket.on("register",(d,cb)=>{
    const fields=["name","gmail","riot","discord"];
    if(!d||fields.some(f=>!String(d[f]||"").trim()))return cb?.({ok:false,error:"Please complete all registration fields."});
    const email=String(d.gmail).trim().toLowerCase();
    const existing=Object.values(state.players).find(p=>p.gmail.toLowerCase()===email);
    if(existing){socket.data.playerId=existing.id;return cb?.({ok:true,player:publicPlayer(existing),state:publicState(),existing:true})}
    const id=crypto.randomUUID();
    state.players[id]={id,name:String(d.name).trim(),gmail:String(d.gmail).trim(),riot:String(d.riot).trim(),discord:String(d.discord).trim(),
      kingdom:null,slot:null,label:"Awaiting Kingdom Assignment",wins:0,losses:0,registeredAt:Date.now()};
    state.playerOrder.push(id);socket.data.playerId=id;save(state);
    cb?.({ok:true,player:publicPlayer(state.players[id]),state:publicState(),existing:false});
    io.emit("playerRegistered",publicPlayer(state.players[id]));
    broadcast();
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
    const attacker=state.players[socket.data.playerId],t=state.territories.find(x=>x.id===tid);
    if(!attacker||!t)return cb?.({ok:false,error:"Invalid player or territory."});
    if(!attacker.kingdom)return cb?.({ok:false,error:"Your Kingdom has not been assigned by the admin yet."});
    if(t.kingdom===attacker.kingdom)return cb?.({ok:false,error:"You cannot attack your own Kingdom."});
    if(activeChallengeForTerritory(tid))return cb?.({ok:false,error:"That territory is already under challenge."});
    const ch={id:crypto.randomUUID(),territoryId:tid,attackerId:attacker.id,defenderKingdom:t.kingdom,defenderId:null,status:"pending",
      createdAt:Date.now(),expiresAt:Date.now()+4*60*60*1000,checkins:{},chat:[]};
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
  socket.on("challengeAccept",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch)return cb?.({ok:false,error:"Challenge not found."});
    if(ch.status!=="pending")return cb?.({ok:false,error:"This challenge is no longer waiting for acceptance."});
    if(p.kingdom!==ch.defenderKingdom)return cb?.({ok:false,error:"Only a player from the defending Kingdom can accept."});
    ch.defenderId=p.id;ch.status="accepted";ch.acceptedAt=Date.now();
    addNotice(`${p.label} accepted a territory challenge.`);
    emitAdmins("challengeAcceptedAdmin",{challenge:ch,defender:publicPlayer(p)});
    io.emit("challengeAccepted",{challenge:ch});broadcast();cb?.({ok:true});
  });
  socket.on("checkin",(id,cb)=>{
    const p=state.players[socket.data.playerId],ch=state.challenges[id];
    if(!p||!ch||![ch.attackerId,ch.defenderId].includes(p.id))return cb?.({ok:false,error:"You are not part of this battle."});
    ch.checkins[p.id]=Date.now();if(ch.checkins[ch.attackerId]&&ch.checkins[ch.defenderId])ch.status="ready";
    io.emit("challengeUpdated",{challenge:ch});broadcast();cb?.({ok:true});
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

app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/api/health",(req,res)=>res.json({ok:true,version:2}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`Kingdom Conquest running on http://localhost:${PORT}`));
