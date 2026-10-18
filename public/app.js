const socket=io();
let me=null,state=null,selectedTerritory=null,activeChallenge=null,isAdmin=false,adminState=null;
let challengeTicker=null,tournamentTicker=null,myMatchUsage={used:0,resetAt:0};
const $=id=>document.getElementById(id);
const K=id=>state?.kingdoms.find(k=>k.id===id);
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const show=id=>$(id).classList.remove("hidden"), hide=id=>$(id).classList.add("hidden");
function fmt(ms){let s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);s%=60;return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`}
function toast(s){$("toast").textContent=s;show("toast");clearTimeout(window.toastT);window.toastT=setTimeout(()=>hide("toast"),3000)}
function playersFor(k){return Object.values(state.players).filter(p=>p.kingdom===k).sort((a,b)=>(a.slot||9)-(b.slot||9))}
function tcount(k){return state.territories.filter(t=>t.kingdom===k).length}

socket.on("connect",()=>{const id=localStorage.getItem("kcPlayerId");if(id)socket.emit("resume",id)});
socket.on("resumeFailed",()=>localStorage.removeItem("kcPlayerId"));
socket.on("myMatchUsage",usage=>{myMatchUsage=usage||myMatchUsage;renderMatchLimits()});
socket.on("registered",({player,state:s})=>{me=player;state=s;playerReady()});
socket.on("assigned",p=>{me=p;localStorage.setItem("kcPlayerId",p.id);playerReady();toast(`Kingdom assigned: ${p.label}`)});
socket.on("state",s=>{state=s;if(me){const fresh=state.players[me.id];if(fresh){me=fresh;if(me.kingdom)playerReady();else showPending()}renderAll()}});
socket.on("playerRegistered",p=>{if(isAdmin)renderAdminRoster()});
socket.on("battleAlert",n=>{toast(n.message);renderAlerts()});
socket.on("challengeIncoming",payload=>{window.incomingChallenge=payload;toast("⚔ Your territory is being challenged.");renderAlerts();showDefenseDashboard()});
socket.on("walkover",payload=>{if(payload){$("walkoverTitle").textContent=payload.title||"VICTORY BY WALKOVER!";$("walkoverText").textContent=payload.message||"The match deadline has expired.";show("walkoverModal")}window.incomingChallenge=null;if(activeChallenge?.id===payload?.challengeId){activeChallenge=null;hide("matchModal")}renderAll()});
socket.on("challengeAccepted",ch=>{if(window.incomingChallenge?.challenge?.id===ch.id)window.incomingChallenge=null;if(me&&(ch.attackerId===me.id||ch.defenderId===me.id)){activeChallenge=ch;openMatch()}renderAll();});
socket.on("challengeUpdated",ch=>{if(activeChallenge?.id===ch.id){activeChallenge=ch;openMatch()}});
socket.on("resultReported",({challenge})=>{if(activeChallenge?.id===challenge.id){activeChallenge=challenge;openMatch();toast("A result has been reported.")}});
socket.on("challengeCancelled",d=>{if(activeChallenge?.id===d.challengeId){activeChallenge=null;hide("matchModal");toast("Challenge cancelled.")}renderAll()});
socket.on("challengeResolved",d=>{if(window.incomingChallenge?.challenge?.id===d.challenge.id)window.incomingChallenge=null;if(activeChallenge?.id===d.challenge.id){activeChallenge=null;hide("matchModal");toast(`${d.winner.label} won the territory.`)}renderAll()});
socket.on("chatMessage",({challengeId,message})=>{if(activeChallenge?.id===challengeId){appendChat(message)}});

function playerReady(){if(!me.kingdom){showPending();return}hide("loginScreen");hide("pendingScreen");hide("scoreScreen");show("mapScreen");$("profileLabel").textContent=`${me.label} · ${K(me.kingdom).name}`;renderAll();startTournamentClock()}
function showPending(){hide("loginScreen");hide("mapScreen");hide("scoreScreen");show("pendingScreen");$("pendingName").textContent=`Welcome, ${me.riot||me.name}`;$("pendingPlayer").textContent=`${me.name} · Registration #${state.playerOrder.indexOf(me.id)+1}`}
$("loginForm").onsubmit=e=>{e.preventDefault();$("loginError").textContent="";socket.emit("register",{riot:$("riot").value.trim(),discord:$("discord").value.trim()},r=>{if(!r?.ok){$("loginError").textContent=r?.error||"Registration failed.";return}me=r.player;state=r.state;localStorage.setItem("kcPlayerId",me.id);playerReady()})};
$("refreshPending").onclick=()=>socket.emit("resume",me.id);
$("pendingLogout").onclick=$("logoutBtn").onclick=()=>{localStorage.removeItem("kcPlayerId");location.reload()};

function renderAll(){if(!state)return;renderFlags();renderAlerts();renderMatchLimits();if($("scoreScreen")&&!$("scoreScreen").classList.contains("hidden"))renderScore();updateActiveChallenge()}
function renderMatchLimits(){
  const wrap=$("matchLimitPlayers");if(!wrap)return;
  if(!me){wrap.innerHTML='<span class="match-limit-empty">Register or sign in to view your match usage.</span>';updateMatchResetTimer();return}
  const used=Math.min(3,Math.max(0,Number(myMatchUsage.used||0)));
  wrap.innerHTML=`<div class="match-limit-player ${used>=3?"limit-reached":""}" title="Your usage: ${used} of 3 matches this hour"><b>${esc(me.label||me.name||"Your matches")}</b><span>${used}/3 MATCHES</span><i><em style="width:${used/3*100}%"></em></i></div>`;
  updateMatchResetTimer();
}
function updateMatchResetTimer(){const el=$("matchResetTimer");if(!el)return;const resetAt=Number(myMatchUsage?.resetAt||state?.matchUsage?.resetAt||0);const left=Math.max(0,resetAt-Date.now());const total=Math.floor(left/1000);el.textContent=`${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;}
function renderFlags(){
  const layer=$("flags");layer.innerHTML="";
  // Positions are based on the ORIGINAL realm shown in the artwork. A captured
  // territory changes flag color but stays in its original territory location.
  const zones=[
    {id:"verdant",x:[7,36],y:[16,35]},
    {id:"frost",x:[37,64],y:[8,28]},
    {id:"stone",x:[66,95],y:[12,34]},
    {id:"sky",x:[5,31],y:[40,61]},
    {id:"sun",x:[73,97],y:[40,62]},
    {id:"ember",x:[10,45],y:[70,91]},
    {id:"shadow",x:[54,91],y:[70,91]}
  ];
  const spots=[];
  for(let r=0;r<3;r++) for(let c=0;c<5;c++) spots.push([(c+0.5)/5,(r+0.5)/3]);
  zones.forEach(z=>{
    for(let i=1;i<=15;i++){
      const t=state.territories.find(q=>q.id===`${z.id}-${i}`);if(!t)continue;
      const owner=K(t.kingdom)||K(z.id);if(!owner)continue;
      const [sx,sy]=spots[i-1];
      const x=z.x[0]+sx*(z.x[1]-z.x[0]), y=z.y[0]+sy*(z.y[1]-z.y[0]);
      const ch=Object.values(state.challenges).find(c=>c.territoryId===t.id&&c.status!=="resolved");
      const b=document.createElement("button");
      b.type="button";b.className="territory-flag";
      b.style.left=x+"%";b.style.top=y+"%";b.style.setProperty("--flag",owner.color);
      if(owner.id===me?.kingdom)b.classList.add("friendly");else b.classList.add("enemy");
      if(ch?.status==="pending")b.classList.add("blinking");
      if(ch?.status==="accepted"||ch?.status==="ready"||ch?.status==="reported"||ch?.status==="disputed")b.classList.add("in-battle");
      b.title=`${owner.name} territory`;
      b.setAttribute("aria-label",`${owner.name} territory`);
      b.onclick=()=>openTarget(t.id);layer.appendChild(b);
    }
  });
}
function openTarget(id){
  selectedTerritory=state.territories.find(t=>t.id===id);if(!selectedTerritory)return;
  const owner=K(selectedTerritory.kingdom);const ch=Object.values(state.challenges).find(c=>c.territoryId===id&&c.status!=="resolved");
  if(ch){
    if(me&&(ch.attackerId===me.id||ch.defenderId===me.id)){activeChallenge=ch;openMatch();return;}
    $("fightingText").textContent=`${owner.name} is currently fighting for this territory. Another challenge cannot start until the current battle is resolved.`;
    show("fightingModal");return;
  }
  $("targetTitle").textContent=`Challenge ${owner.name} Territory`;
  $("targetOwner").innerHTML=`<span class="kingdom-dot" style="background:${owner.color}"></span><b>${owner.icon} ${owner.name}</b><small>Current territory owner</small>`;
  const blocked=!me?.kingdom||owner.id===me.kingdom;
  $("confirmChallenge").disabled=blocked;
  $("confirmChallenge").textContent=!me?.kingdom?"WAITING FOR KINGDOM ASSIGNMENT":owner.id===me.kingdom?"YOUR KINGDOM TERRITORY":"⚔ CHALLENGE THIS TERRITORY";
  show("challengePrompt");
}
$("confirmChallenge").onclick=()=>{if(!selectedTerritory)return;socket.emit("challengeCreate",selectedTerritory.id,r=>{if(!r?.ok)return toast(r?.error||"Challenge failed.");activeChallenge=r.challenge;hide("challengePrompt");openMatch();renderAll()})};

function showDefenseDashboard(){const x=window.incomingChallenge;if(!x?.challenge||x.challenge.status!=="pending")return;const ch=x.challenge;$("defenseDetails").textContent=`${x.attacker?.label||"An opponent"} challenged Territory ${x.territory?.num||"?"} of ${x.defenderKingdom?.name||"your Kingdom"}.`;show("defenseDashboard");const tick=()=>{const left=Math.max(0,ch.expiresAt-Date.now());$("defenseTimer").textContent=fmt(left);if(left<=0){clearInterval(window.defenseTicker);hide("defenseDashboard")}};clearInterval(window.defenseTicker);tick();window.defenseTicker=setInterval(tick,250)}
$("acceptDefense").onclick=()=>{const ch=window.incomingChallenge?.challenge;if(!ch)return;socket.emit("challengeAccept",ch.id,r=>{if(!r?.ok){toast(r?.error||"Challenge acceptance failed.");return}window.incomingChallenge=null;hide("defenseDashboard");hide("alertsPanel");activeChallenge=state?.challenges?.[ch.id]||{...ch,...r.challenge};openMatch();renderAll()})};
$("dismissDefense").onclick=()=>hide("defenseDashboard");$("closeWalkover").onclick=()=>hide("walkoverModal");
function updateActiveChallenge(){if(!activeChallenge)return;const f=state.challenges[activeChallenge.id];if(f)activeChallenge=f}
function openMatch(){
  if(!activeChallenge)return;const ch=state.challenges[activeChallenge.id]||activeChallenge;activeChallenge=ch;
  const terr=state.territories.find(t=>t.id===ch.territoryId),a=state.players[ch.attackerId],d=ch.defenderId?state.players[ch.defenderId]:null;
  $("matchTitle").textContent=`Territory ${terr?.num||""} · ${K(ch.defenderKingdom).name}`;
  $("attackerName").textContent=a?.label||"Attacker";$("attackerKingdom").textContent=a?K(a.kingdom).name:"";
  $("defenderName").textContent=d?.label||"Waiting for a defender…";$("defenderKingdom").textContent=d?K(d.kingdom).name:K(ch.defenderKingdom).name;
  $("attackerSymbol").style.color=a?K(a.kingdom).color:"#fff";$("defenderSymbol").style.color=d?K(d.kingdom).color:K(ch.defenderKingdom).color;
  $("waitingText").textContent=ch.status==="pending"?`Any ${K(ch.defenderKingdom).name} player can accept this challenge.`:`${d?.label||"A defender"} accepted the challenge.`;
  if(ch.status==="accepted"&&ch.checkinExpiresAt){$("waitingTitle").textContent="GAME CHECK-IN WINDOW";$("waitingText").textContent=`Both players must check in. Time remaining: ${fmt(ch.checkinExpiresAt-Date.now())}`;$ ("waitingBox").classList.remove("hidden");}
  $("waitingBox").classList.toggle("hidden",ch.status!=="pending");
  $("cancelChallenge").classList.toggle("hidden",!(ch.status==="pending"&&me.id===ch.attackerId));
  $("attackerCheckin").disabled=me.id!==ch.attackerId||!!ch.checkins?.[ch.attackerId];
  $("defenderCheckin").disabled=me.id!==ch.defenderId||!!ch.checkins?.[ch.defenderId]||!d;
  $("attackerCheckState").textContent=ch.checkins?.[ch.attackerId]?"✓ Checked in":"Not checked in";
  $("defenderCheckState").textContent=ch.checkins?.[ch.defenderId]?"✓ Checked in":"Not checked in";
  const ready=!!ch.checkins?.[ch.attackerId]&&!!ch.checkins?.[ch.defenderId];
  $("reportBox").classList.toggle("hidden",!ready);
  const mine=state.reports?.[ch.id]?.[me.id];$("iWin").disabled=!!mine;$("iLose").disabled=!!mine;
  renderChat(ch.chat||[]);show("matchModal");
  clearInterval(challengeTicker);
  if(ch.status==="pending"||ch.status==="accepted")challengeTicker=setInterval(()=>{const deadline=ch.status==="pending"?ch.expiresAt:ch.checkinExpiresAt;const remain=Number(deadline||0)-Date.now();$("responseTimer").textContent=fmt(remain);if(ch.status==="accepted")$("waitingText").textContent=`Both players must check in. Time remaining: ${fmt(remain)}`;if(remain<=0)clearInterval(challengeTicker)},250);
}
$("cancelChallenge").onclick=()=>{if(!activeChallenge)return;if(!confirm("Cancel this challenge?"))return;socket.emit("challengeCancel",activeChallenge.id,r=>{if(!r?.ok)return toast(r?.error||"Cancel failed.");activeChallenge=null;hide("matchModal");toast("Challenge cancelled.");renderAll()})};
$("attackerCheckin").onclick=$("defenderCheckin").onclick=()=>socket.emit("checkin",activeChallenge.id,r=>{if(!r?.ok)toast(r?.error||"Check-in failed.")});
$("iWin").onclick=()=>report("win");$("iLose").onclick=()=>report("loss");
function report(result){socket.emit("reportResult",activeChallenge.id,result,r=>{if(!r?.ok)toast(r?.error||"Report failed.");else toast("Result submitted.")})}
$("closeMatch").onclick=()=>hide("matchModal");

function renderChat(messages){$("chatMessages").innerHTML="";messages.forEach(appendChat);$("chatMessages").scrollTop=$("chatMessages").scrollHeight}
function appendChat(m){const mine=m.playerId===me.id;const el=document.createElement("div");el.className="chat-msg "+(mine?"mine":"theirs");el.innerHTML=`<b>${esc(m.label)}</b><span>${esc(m.text)}</span><small>${new Date(m.time).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</small>`;$("chatMessages").appendChild(el);$("chatMessages").scrollTop=$("chatMessages").scrollHeight}
$("chatForm").onsubmit=e=>{e.preventDefault();const v=$("chatInput").value.trim();if(!v||!activeChallenge)return;socket.emit("chat",activeChallenge.id,v,r=>{if(r?.ok)$("chatInput").value=""})};

function renderAlerts(){
  const arr=state.notifications||[];
  $("alertCount").textContent=Math.min(arr.length+(window.incomingChallenge?1:0),99);
  let html="";
  if(window.incomingChallenge){
    const ch=window.incomingChallenge.challenge,a=window.incomingChallenge.attacker;
    if(ch?.status==="pending") html+=`<div class="alert-item incoming-challenge"><b>⚔ TERRITORY CHALLENGE</b><span>${esc(a?.label||"An opponent")} challenged one of your Kingdom's territories.</span><button class="gold-button small accept-incoming" data-challenge="${ch.id}">ACCEPT CHALLENGE</button></div>`;
  }
  html+=(arr.slice(0,30).map(n=>`<div class="alert-item"><b>⚔ BATTLE ALERT</b><span>${esc(n.message)}</span><small>${new Date(n.time).toLocaleTimeString()}</small></div>`).join(""));
  $("alerts").innerHTML=html||"<div class='alert-item'>No battle alerts.</div>";
  document.querySelectorAll(".accept-incoming").forEach(b=>b.onclick=()=>socket.emit("challengeAccept",b.dataset.challenge,r=>{if(!r?.ok){toast(r?.error||"Challenge acceptance failed.");return}window.incomingChallenge=null;hide("alertsPanel");activeChallenge=r.challenge;openMatch();renderAll()}));
}
$("alertButton").onclick=()=>{renderAlerts();show("alertsPanel")};$("closeAlerts").onclick=()=>hide("alertsPanel");$("closeFighting").onclick=()=>hide("fightingModal");

$("playersBtn").onclick=()=>{renderPublicPlayers();show("playersModal")};
function renderPublicPlayers(){const list=state.playerOrder.map((id,i)=>state.players[id]).filter(Boolean);$("publicPlayers").innerHTML=list.map((p,i)=>`<div class="public-player"><div class="pnum">#${i+1}</div><div><b>${esc(p.riot||p.name)}</b><small>${p.kingdom?`${K(p.kingdom).icon} ${esc(K(p.kingdom).name)} · ${esc(p.label)}`:"Awaiting Kingdom assignment"}</small></div><span class="${p.kingdom?"assigned":"waiting"}">${p.kingdom?"ASSIGNED":"WAITING"}</span></div>`).join("")||"<div class='admin-empty'>No players registered yet.</div>"}

$("scoreBtn").onclick=()=>{renderScore();hide("mapScreen");show("scoreScreen")};$("backMap").onclick=()=>{hide("scoreScreen");show("mapScreen")};
function renderScore(){const list=state.kingdoms.map(k=>({...k,territories:tcount(k.id),players:playersFor(k.id),defense:Math.max(0,Math.min(3,Number(state.defensePoints?.[k.id]??3)))})).sort((a,b)=>b.territories-a.territories||(b.players.reduce((x,p)=>x+p.wins,0)-a.players.reduce((x,p)=>x+p.wins,0)));$("scoreGrid").innerHTML=list.map((k,i)=>{const risk=k.defense===0;const pct=(k.defense/3)*100;return `<article class="kingdom-card ${i===0?"champion":""}" style="--accent:${k.color}"><div class="kc-head"><div class="rank">${i===0?"♛":"#"+(i+1)}</div><div class="kname">${k.icon} ${esc(k.name)}<div class="defense-points ${risk?"critical":""}"><span>DEFENSE POINTS</span><b>${k.defense}/3</b>${risk?"<em>IN RISK</em>":""}</div><div class="defense-meter ${risk?"critical":""}" role="img" aria-label="Defense ${k.defense} out of 3"><span style="width:${pct}%"></span></div></div><div class="territories"><b>${k.territories}</b><span>TERRITORIES</span></div></div><div class="player-head"><span>CHAMPIONS</span><span>WINS</span><span>LOSSES</span></div>${k.players.length?k.players.map(p=>`<div class="player-row"><div class="player-name"><i>♟</i><b>${esc(p.label)}</b></div><strong class="wins">${p.wins}</strong><strong class="losses">${p.losses}</strong></div>`).join(""):"<div class='unassigned-row'>No players assigned yet.</div>"}</article>`}).join("")}

$("profileBtn").onclick=()=>{const k=K(me.kingdom);$("profileName").textContent=me.label;$("profileData").innerHTML=[["Name",me.name],["Kingdom",k?`${k.icon} ${k.name}`:"Awaiting assignment"],["Slot",me.slot||"—"],["Wins",me.wins],["Losses",me.losses]].map(x=>`<div class="profile-row"><span>${x[0]}</span><b>${esc(x[1])}</b></div>`).join("");show("profileModal")};
$("logoutBtn").onclick=()=>{localStorage.removeItem("kcPlayerId");location.reload()};
document.querySelectorAll("[data-close]").forEach(x=>x.onclick=()=>hide(x.dataset.close));

function startTournamentClock(){clearInterval(tournamentTicker);const tick=()=>{if(!state.tournamentStartedAt){$("tournamentTimer").textContent="NOT STARTED"}else{const r=Math.max(0,172800000-(Date.now()-state.tournamentStartedAt));$("tournamentTimer").textContent=fmt(r)}updateMatchResetTimer()};tick();tournamentTicker=setInterval(tick,1000)}

$("adminBtn").onclick=()=>{const pass=prompt("Admin password:");if(pass===null)return;socket.emit("adminLogin",pass,r=>{if(!r?.ok){toast(r?.error||"Admin login failed.");return}isAdmin=true;adminState=r.state;openAdmin("roster")})};
function openAdmin(tab){renderAdmin(tab);show("adminModal")}
document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-tab]").forEach(x=>x.classList.remove("active"));b.classList.add("active");renderAdmin(b.dataset.tab)});
function renderAdmin(tab="roster"){socket.emit("adminState",r=>{if(!r?.ok)return;adminState=r.state;const c=$("adminContent");if(tab==="roster"){c.innerHTML=`<div class="admin-tools"><button id="startTournament" class="gold-button small">START 48-HOUR TOURNAMENT</button><button id="resetTournament" class="dark-button">RESET TEST DATA</button></div><div class="admin-note">Full registration details are visible only here. Assign a Kingdom to each player; the server will allocate A/B/C slots automatically.</div><div class="admin-roster">${adminState.playerOrder.map((id,i)=>{const p=adminState.players[id];return `<div class="admin-player"><div class="admin-pnum">#${i+1}</div><div class="admin-pinfo"><b>${esc(p.name)}</b><small>Gmail: ${esc(p.gmail)} · RoT: ${esc(p.riot)} · Discord: ${esc(p.discord)}</small></div><div class="admin-assignment"><span>${p.kingdom?esc(p.label):"Awaiting assignment"}</span><select data-assign="${p.id}"><option value="">Assign Kingdom…</option>${state.kingdoms.map(k=>`<option value="${k.id}" ${p.kingdom===k.id?"selected":""}>${k.name}</option>`).join("")}</select></div></div>`}).join("")||"<div class='admin-empty'>No registrations yet.</div>"}</div>`;$("startTournament").onclick=()=>socket.emit("adminStartTournament",r=>{if(r?.ok){toast("48-hour tournament started.");renderAdmin(tab)}else toast(r?.error||"Cannot start tournament.")});$("resetTournament").onclick=()=>{if(confirm("Reset all tournament data and registrations?"))socket.emit("adminResetTournament",()=>{toast("Tournament data reset.");location.reload()})};document.querySelectorAll("[data-assign]").forEach(s=>s.onchange=()=>{if(!s.value)return;socket.emit("adminAssign",s.dataset.assign,s.value,r=>{if(r?.ok){toast("Kingdom assigned.");renderAdmin("roster")}else{toast(r?.error||"Assignment failed.");renderAdmin("roster")}})})}
else{const reported=Object.values(adminState.challenges).filter(c=>c.status==="reported");c.innerHTML=reported.length?reported.map(ch=>{const a=adminState.players[ch.attackerId],d=adminState.players[ch.defenderId],rs=adminState.reports[ch.id]||{},first=Object.values(rs).sort((x,y)=>x.time-y.time)[0],remaining=first?Math.max(0,300000-(Date.now()-first.time)):0;return `<div class="admin-item"><b>Territory ${adminState.territories.find(t=>t.id===ch.territoryId)?.num||"?"}</b><small>${esc(a.label)} vs ${esc(d.label)} · Admin window ${fmt(remaining)}</small><div class="admin-reports"><span>${esc(a.label)}: ${rs[a.id]?.result?.toUpperCase()||"—"}</span><span>${esc(d.label)}: ${rs[d.id]?.result?.toUpperCase()||"—"}</span></div><div class="admin-actions"><button data-win="${a.id}" data-ch="${ch.id}">${esc(a.label)} WINS</button><button data-win="${d.id}" data-ch="${ch.id}">${esc(d.label)} WINS</button></div></div>`}).join(""):"<div class='admin-empty'>No reported battles require approval.</div>";document.querySelectorAll("[data-win]").forEach(b=>b.onclick=()=>socket.emit("adminResolve",b.dataset.ch,b.dataset.win,r=>{if(r?.ok){toast("Winner approved.");renderAdmin("battles")}else toast(r?.error||"Approval failed.")}))}})}

document.querySelectorAll("[data-close]").forEach(x=>x.onclick=()=>hide(x.dataset.close));
