const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

// Render PostgreSQL is the durable source of truth when DATABASE_URL is configured.
// The JSON file remains a local fallback and a convenient recovery snapshot.
let pgPool = null;
let databaseReady = false;
let databaseWrites = Promise.resolve();
let databaseLastError = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const TOURNAMENT_DURATION_MS = 48 * 60 * 60 * 1000;
const CHALLENGE_RESPONSE_MS = 15 * 60 * 1000;
const CHECKIN_WINDOW_MS = 5 * 60 * 1000;
const PLAYER_MATCH_LIMIT = 5;
const PLAYER_MATCH_PERIOD_MS = 2 * 60 * 60 * 1000;
const MAX_APPROVED_PLAYERS = 30;
const ADMIN_ID = process.env.ADMIN_ID || "kamleshhhh";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kamlesh078";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const kingdoms = [
  { id: "verdant", name: "Valoria", color: "#d6a33c", icon: "♛" },
  { id: "frost", name: "Northgard", color: "#388ee8", icon: "❄" },
  { id: "stone", name: "Ironclad", color: "#aab4c2", icon: "⬟" },
  { id: "sky", name: "Frostfang", color: "#23a78d", icon: "♆" },
  { id: "sun", name: "Silverdawn", color: "#e8d7a0", icon: "☀" },
  { id: "ember", name: "Emberfall", color: "#e34a24", icon: "🔥" },
  { id: "shadow", name: "Shadow Realm", color: "#9b45d5", icon: "☾" },
  { id: "storm", name: "Stormlands", color: "#48a94f", icon: "ϟ" },
  { id: "void", name: "Void Empire", color: "#a23fe1", icon: "◉" },
  { id: "crimson", name: "Crimson Hold", color: "#db3037", icon: "♜" }
];

const zones = [
  { id: "frost", x: [8, 25], y: [14, 31] }, { id: "verdant", x: [38, 55], y: [8, 25] },
  { id: "ember", x: [73, 91], y: [14, 31] }, { id: "shadow", x: [4, 22], y: [38, 55] },
  { id: "storm", x: [25, 42], y: [37, 54] }, { id: "stone", x: [45, 62], y: [37, 54] },
  { id: "void", x: [77, 95], y: [38, 55] }, { id: "crimson", x: [8, 26], y: [68, 85] },
  { id: "sun", x: [38, 56], y: [70, 87] }, { id: "sky", x: [72, 91], y: [68, 85] }
];

function blankState() {
  const territories = [];
  kingdoms.forEach(k => {
    for (let i = 1; i <= 15; i++) territories.push({ id: `${k.id}-${i}`, num: i, kingdom: k.id, originalKingdom: k.id });
  });
  return {
    version: 6,
    tournamentStartedAt: null,
    tournamentStoppedAt: null,
    players: {},
    playerOrder: [],
    territories,
    challenges: {},
    reports: {},
    notifications: [],
    adminEvents: [],
    completedBattles: [],
    defensePoints: Object.fromEntries(kingdoms.map(k => [k.id, 3])),
    matchUsage: { players: {} }, lastDefenseRegenAt: Date.now(), lastOpponentByAttackingKingdom: {}, attackHistoryByKingdom: {}, peaceTime: { startedAt: null, endsAt: null, startedBy: null }
  };
}
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if ((parsed.version >= 3) && Array.isArray(parsed.territories) && parsed.territories.length >= 105) {
        if (parsed.version === 3) {
          // v3 used 0/1/2 as accumulated unanswered counts. v4+ uses remaining Defense Points.
          const old = parsed.defensePoints || {};
          parsed.defensePoints = Object.fromEntries(kingdoms.map(k => { const n = Number(old[k.id]); return [k.id, Number.isFinite(n) ? Math.max(0, Math.min(3, 3 - n)) : 3] }));
        }
        // Keep every existing registration. Previously assigned players stay approved;
        // unassigned legacy registrations remain pending for admin review.
        parsed.players = parsed.players || {};
        for (const player of Object.values(parsed.players)) {
          if (typeof player.approved !== "boolean") player.approved = !!player.kingdom;
          if (!player.approvalStatus) player.approvalStatus = player.approved ? "approved" : "pending";
        }
        // Expand legacy 7-kingdom saves to the 10-kingdom / 150-territory format
        // without deleting registrations, approvals, assignments, or existing territory ownership.
        const existingIds = new Set(parsed.territories.map(t => t.id));
        for (const k of kingdoms) {
          for (let i = 1; i <= 15; i++) {
            const id = `${k.id}-${i}`;
            if (!existingIds.has(id)) parsed.territories.push({ id, num: i, kingdom: k.id, originalKingdom: k.id });
          }
        }
        parsed.territories = parsed.territories.filter(t => kingdoms.some(k => t.id.startsWith(k.id + "-")));
        // Defense Points are a shared kingdom-wide balance, never stored per territory.
        for (const t of parsed.territories) delete t.defensePoints;
        if (!parsed.defensePoints) parsed.defensePoints = {};
        for (const k of kingdoms) if (!Number.isFinite(Number(parsed.defensePoints[k.id]))) parsed.defensePoints[k.id] = 3;
        parsed.peaceTime = parsed.peaceTime || { startedAt: null, endsAt: null, startedBy: null };
        parsed.version = 6;
        if (!parsed.matchUsage || typeof parsed.matchUsage !== "object") parsed.matchUsage = { players: {} };
        if (!parsed.lastOpponentByAttackingKingdom || typeof parsed.lastOpponentByAttackingKingdom !== "object") parsed.lastOpponentByAttackingKingdom = {};
        if (!parsed.attackHistoryByKingdom || typeof parsed.attackHistoryByKingdom !== "object") parsed.attackHistoryByKingdom = {};
        save(parsed);
        return parsed
      };
    }
  } catch (e) { console.error("Data load:", e) }
  const s = blankState(); save(s); return s;
}
function ensureStateShape() {
  state.defensePoints = state.defensePoints || {};
  kingdoms.forEach(k => { if (!Number.isFinite(state.defensePoints[k.id])) state.defensePoints[k.id] = 3; state.defensePoints[k.id] = Math.max(0, Math.min(3, Math.round(state.defensePoints[k.id]))); });
  if (!state.matchUsage || typeof state.matchUsage !== "object") state.matchUsage = { players: {} };
  // Migrate older shared-hour counters to personal rolling two-hour windows.
  if (!state.matchUsage.players || typeof state.matchUsage.players !== "object") {
    const old = state.matchUsage.counts || {};
    state.matchUsage = { players: {} };
    for (const [pid, used] of Object.entries(old)) state.matchUsage.players[pid] = { used: Number(used) || 0, windowStart: null, resetAt: null };
  }
  if (!Number.isFinite(state.lastDefenseRegenAt)) state.lastDefenseRegenAt = Date.now();
  if (state.tournamentStoppedAt === undefined) state.tournamentStoppedAt = null;
  if (!state.lastOpponentByAttackingKingdom || typeof state.lastOpponentByAttackingKingdom !== "object") state.lastOpponentByAttackingKingdom = {};
  if (!state.attackHistoryByKingdom || typeof state.attackHistoryByKingdom !== "object") state.attackHistoryByKingdom = {};
  if (!state.peaceTime || typeof state.peaceTime !== "object") state.peaceTime = { startedAt: null, endsAt: null, startedBy: null };
  for (const p of Object.values(state.players || {})) {
    if (typeof p.approved !== "boolean") p.approved = !!p.kingdom;
    if (!p.approvalStatus) p.approvalStatus = p.approved ? "approved" : "pending";
  }
  // Defense Points are shared by each whole kingdom, not by individual territories.
  for (const t of state.territories) delete t.defensePoints;
  state.version = 6;
}
function usageFor(playerId) {
  const now = Date.now();
  let u = state.matchUsage.players[playerId];
  if (!u || typeof u !== "object") u = state.matchUsage.players[playerId] = { used: 0, windowStart: null, resetAt: null };
  if (u.resetAt && now >= u.resetAt) { u.used = 0; u.windowStart = null; u.resetAt = null; }
  u.used = Math.max(0, Math.min(PLAYER_MATCH_LIMIT, Number(u.used) || 0));
  return u;
}
function publicUsage(playerId) { const u = usageFor(playerId); return { used: u.used, windowStart: u.windowStart || null, resetAt: u.resetAt || null, limit: PLAYER_MATCH_LIMIT, periodMs: PLAYER_MATCH_PERIOD_MS }; }
function canStartMatch(playerId) { return usageFor(playerId).used < PLAYER_MATCH_LIMIT; }
function startMatchUsage(playerIds) {
  const now = Date.now();
  for (const pid of playerIds) {
    const u = usageFor(pid);
    if (u.used >= PLAYER_MATCH_LIMIT) return { ok: false, playerId: pid };
  }
  for (const pid of playerIds) { const u = usageFor(pid); if (!u.windowStart) { u.windowStart = now; u.resetAt = now + PLAYER_MATCH_PERIOD_MS; } u.used += 1; }
  return { ok: true };
}
function tournamentIsActive(now = Date.now()) {
  if (state.tournamentStartedAt === null || state.tournamentStartedAt === undefined) return false;
  const startedAt = Number(state.tournamentStartedAt);
  return !state.tournamentStoppedAt && Number.isFinite(startedAt) && now >= startedAt && now - startedAt < TOURNAMENT_DURATION_MS;
}
function peaceTimeActive(now = Date.now()) { return !!(state.peaceTime && Number(state.peaceTime.endsAt) > now); }
function peaceTimeRemaining(now = Date.now()) { return peaceTimeActive(now) ? Number(state.peaceTime.endsAt) - now : 0; }
function tournamentHasEnded(now = Date.now()) {
  if (state.tournamentStartedAt === null || state.tournamentStartedAt === undefined) return false;
  const startedAt = Number(state.tournamentStartedAt);
  return Number.isFinite(startedAt) && now - startedAt >= TOURNAMENT_DURATION_MS;
}
function regenerateDefensePoints() {
  if (!tournamentIsActive()) return false;
  const now = Date.now(), hours = Math.floor((now - state.lastDefenseRegenAt) / 3600000);
  if (hours <= 0) return false;
  for (const k of kingdoms) state.defensePoints[k.id] = Math.min(3, Math.max(0, Number(state.defensePoints[k.id] ?? 3)) + hours);
  state.lastDefenseRegenAt += hours * 3600000;
  return true;
}

function save(s) {
  const serialized = JSON.stringify(s, null, 2);
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, DATA_FILE);
  if (pgPool && databaseReady) {
    // Serialize writes so rapid registrations cannot overwrite a newer snapshot.
    const snapshot = JSON.stringify(s);
    databaseWrites = databaseWrites.then(() => pgPool.query(
      `INSERT INTO tournament_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [snapshot]
    )).then(() => { databaseLastError = null; }).catch(err => {
      databaseLastError = String(err.message || err);
      console.error("PostgreSQL persistence failed:", databaseLastError);
    });
  }
}
let state = load();
ensureStateShape();

async function initializePersistentStorage() {
  if (!pgPool) {
    if (process.env.RENDER) throw new Error("DATABASE_URL is required on Render before the site can safely accept registrations.");
    console.warn("DATABASE_URL is not set. Running with local JSON storage only; this is NOT durable across Render deployments.");
    return;
  }
  await pgPool.query(`CREATE TABLE IF NOT EXISTS tournament_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const result = await pgPool.query("SELECT payload FROM tournament_state WHERE id = 1");
  if (result.rows.length && result.rows[0].payload) {
    state = result.rows[0].payload;
    ensureStateShape();
    const serialized = JSON.stringify(state, null, 2);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, serialized);
  } else {
    ensureStateShape();
    await pgPool.query("INSERT INTO tournament_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO NOTHING", [JSON.stringify(state)]);
    const latest = await pgPool.query("SELECT payload FROM tournament_state WHERE id = 1");
    if (latest.rows[0]?.payload) state = latest.rows[0].payload;
    ensureStateShape();
  }
  databaseReady = true;
  // Persist any safe shape migrations performed during startup.
  const snapshot = JSON.stringify(state);
  await pgPool.query("UPDATE tournament_state SET payload = $1::jsonb, updated_at = NOW() WHERE id = 1", [snapshot]);
  console.log("Persistent PostgreSQL storage is ready.");
}

function K(id) { return kingdoms.find(k => k.id === id) }
function publicPlayer(p) {
  if (!p) return null;
  return { id: p.id, name: p.name, riot: p.riot, kingdom: p.kingdom, slot: p.slot, label: p.label, wins: p.wins, losses: p.losses, approved: p.approved !== false, approvalStatus: p.approvalStatus || ((p.approved !== false) ? "approved" : "pending"), status: p.approved === false ? "Pending Approval" : (p.kingdom ? "Assigned" : "Awaiting Kingdom") };
}
function privatePlayer(p) {
  if (!p) return null;
  return { ...publicPlayer(p), discord: p.discord || "", gmail: p.gmail || "", lastIpAddress: p.lastIpAddress || "Not recorded", lastSeenAt: p.lastSeenAt || null, lastConnectedAt: p.lastConnectedAt || null, connectionCount: Number(p.connectionCount || 0), registeredAt: p.registeredAt || null, ipLocation: p.ipLocation || null };
}
function publicState() {
  return {
    tournamentStartedAt: state.tournamentStartedAt,
    tournamentStoppedAt: state.tournamentStoppedAt || null,
    peaceTime: state.peaceTime || { startedAt: null, endsAt: null, startedBy: null },
    players: Object.fromEntries(Object.entries(state.players).filter(([, p]) => p.approved !== false).map(([id, p]) => [id, publicPlayer(p)])),
    playerOrder: state.playerOrder,
    territories: state.territories,
    challenges: state.challenges,
    completedBattles: (state.completedBattles || []).map(ch => ({ id: ch.id, territoryId: ch.territoryId, attackerId: ch.attackerId, attackerKingdom: ch.attackerKingdom, defenderId: ch.defenderId, defenderKingdom: ch.defenderKingdom, status: ch.status || "completed", winnerId: ch.winnerId || null, createdAt: ch.createdAt || ch.completedAt, resolvedAt: ch.resolvedAt || ch.completedAt, resolutionReason: ch.resolutionReason || "" })),
    reports: state.reports,
    notifications: state.notifications.slice(0, 100),
    kingdoms,
    defensePoints: state.defensePoints,
    matchUsage: { periodMs: 7200000 }
  };
}
function adminState() {
  return {
    ...publicState(),
    players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, privatePlayer(p)])),
    completedBattles: state.completedBattles || [],
    matchUsage: { periodMs: 7200000, players: state.matchUsage.players }
  };
}
function socketIdsForPlayer(playerId) {
  return [...io.sockets.sockets.values()].filter(s => s.data.playerId === playerId).map(s => s.id)
}
function emitPlayer(playerId, event, payload) {
  for (const sid of socketIdsForPlayer(playerId)) io.to(sid).emit(event, payload)
}
function playerInMatch(playerId, excludeChallengeId = null) {
  // A pending challenge already reserves its attacker. When accepting that same
  // challenge, exclude it from the attacker's own lock check.
  return Object.values(state.challenges).some(ch => ch.id !== excludeChallengeId &&
    [ch.attackerId, ch.defenderId].includes(playerId) &&
    ["pending", "accepted", "ready", "reported", "disputed"].includes(ch.status));
}
function notifyKingdom(kid, event, payload) {
  Object.values(state.players).filter(p => p.approved !== false && p.kingdom === kid).forEach(p => emitPlayer(p.id, event, payload))
}
function emitAdmins(event, payload) {
  for (const s of io.sockets.sockets.values()) if (s.data.isAdmin) s.emit(event, payload)
}
function addNotice(message, kingdomId = null) {
  const n = { id: crypto.randomUUID(), message, kingdomId, time: Date.now() };
  state.notifications.unshift(n); state.notifications = state.notifications.slice(0, 100);
  if (kingdomId) notifyKingdom(kingdomId, "battleAlert", n);
}
function broadcast() {
  save(state); io.emit("state", publicState());
  // Match counts are private to each player; only send each player their own usage.
  for (const p of Object.values(state.players)) emitPlayer(p.id, "myMatchUsage", publicUsage(p.id));
}
function slotFor(kid) {
  const used = Object.values(state.players).filter(p => p.approved !== false && p.kingdom === kid).length;
  return used < 3 ? used + 1 : null;
}
function labelFor(kid, slot) { return `${K(kid).name} ${String.fromCharCode(64 + slot)}` }
function activeChallengeForTerritory(tid) {
  return Object.values(state.challenges).find(c => c.territoryId === tid && c.status !== "resolved")
}
function resolve(chId, winnerId, reason) {
  const ch = state.challenges[chId], winner = state.players[winnerId];
  if (!ch || !winner) return;
  const t = state.territories.find(x => x.id === ch.territoryId);
  if (!t) return;
  const old = t.kingdom;
  const attackingKingdom = state.players[ch.attackerId]?.kingdom;
  if (attackingKingdom && ch.defenderKingdom) state.lastOpponentByAttackingKingdom[attackingKingdom] = ch.defenderKingdom;
  const loserId = winnerId === ch.attackerId ? ch.defenderId : ch.attackerId;
  winner.wins++;
  if (loserId && state.players[loserId]) state.players[loserId].losses++;
  t.kingdom = winner.kingdom;
  ch.status = "resolved"; ch.winnerId = winnerId; ch.resolutionReason = reason; ch.resolvedAt = Date.now();
  const completed = { ...ch, territory: { ...t }, winner: publicPlayer(winner), reports: state.reports[chId] || {}, completedAt: Date.now() };
  state.completedBattles = state.completedBattles || [];
  state.completedBattles.unshift(completed);
  state.completedBattles = state.completedBattles.slice(0, 200);
  addNotice(`${winner.label} captured Territory ${t.num} of ${K(old).name}.`);
  emitAdmins("battleResolved", completed);
  io.emit("challengeResolved", { challenge: ch, territory: t, winner: publicPlayer(winner) });
  delete state.challenges[chId]; delete state.reports[chId];
  broadcast();
}
function applyDefensiveFailure(ch, source) {
  if (!ch || ch.status !== "pending") return;
  const attacker = state.players[ch.attackerId];
  const defenderKingdom = ch.defenderKingdom;
  if (!attacker || !defenderKingdom) { delete state.challenges[ch.id]; delete state.reports[ch.id]; broadcast(); return; }
  const challengedTerritory = state.territories.find(t => t.id === ch.territoryId);
  if (attacker.kingdom && defenderKingdom) state.lastOpponentByAttackingKingdom[attacker.kingdom] = defenderKingdom;
  const points = Math.max(0, Math.min(3, Number(state.defensePoints?.[defenderKingdom] ?? 3)));
  const failureText = source === "the challenge expired" ? "did not respond within 15 minutes" : source;
  // Defense Points belong to the whole kingdom. When the kingdom is already at zero,
  // the next unanswered/fully-declined challenge captures the challenged territory.
  if (points === 0) {
    ch.walkover = true;
    resolve(ch.id, attacker.id, `Automatic occupation: ${K(defenderKingdom)?.name || "The defending Kingdom"} had zero kingdom-wide Defense Points and ${failureText}.`);
    const detail = source === "the challenge expired" ? "failed to respond within 15 minutes" : "all three defenders declined the challenge";
    emitPlayer(attacker.id, "walkover", { challengeId: ch.id, title: "TERRITORY OCCUPIED!", message: `The defending Kingdom had zero kingdom-wide Defense Points and ${detail}. The territory has been occupied.` });
    notifyKingdom(defenderKingdom, "walkover", { challengeId: ch.id, title: "TERRITORY LOST", message: `Your Kingdom had zero Defense Points and ${detail}. The territory has been occupied.` });
    return;
  }
  const remaining = Math.max(0, points - 1);
  state.defensePoints[defenderKingdom] = remaining;
  delete state.challenges[ch.id]; delete state.reports[ch.id];
  addNotice(`${K(defenderKingdom)?.name || "The defending Kingdom"} ${failureText}. Kingdom-wide Defense Points decreased to ${remaining}/3.`, defenderKingdom);
  io.emit("challengeCancelled", { challengeId: ch.id, territoryId: ch.territoryId, reason: source, defenderKingdom, defensePoints: remaining });
  emitPlayer(attacker.id, "walkover", { challengeId: ch.id, title: "DEFENSE POINT LOST", message: `The defending Kingdom ${failureText}. Its shared kingdom Defense Points decreased to ${remaining}/3; the territory was not captured.` });
  notifyKingdom(defenderKingdom, "walkover", { challengeId: ch.id, title: "CHALLENGE FAILED", message: `Your Kingdom ${failureText} and lost 1 shared Defense Point. ${remaining} Defense Point(s) remain across your entire Kingdom.` });
  broadcast();
}
function expirePendingChallenge(chId) {
  const ch = state.challenges[chId];
  if (!ch || ch.status !== "pending") return;
  applyDefensiveFailure(ch, "the challenge expired");
}
function expireCheckin(chId) {
  const ch = state.challenges[chId];
  if (!ch || ch.status !== "accepted") return;
  const a = !!ch.checkins?.[ch.attackerId], d = !!ch.checkins?.[ch.defenderId];
  if (a && d) { ch.status = "ready"; broadcast(); return; }
  if (a === d) {
    const payload = { challengeId: chId, title: "NO-SHOW", message: "Neither player checked in within five minutes. The match was recorded as a no-show." };
    [ch.attackerId, ch.defenderId].filter(Boolean).forEach(pid => emitPlayer(pid, "walkover", payload));
    state.completedBattles = state.completedBattles || []; state.completedBattles.unshift({ ...ch, status: "no-show", resolutionReason: payload.message, completedAt: Date.now() });
    delete state.challenges[chId]; delete state.reports[chId]; broadcast(); return;
  }
  const winnerId = a ? ch.attackerId : ch.defenderId;
  const loserId = a ? ch.defenderId : ch.attackerId;
  resolve(chId, winnerId, "Victory by walkover: opponent failed to check in within five minutes.");
  emitPlayer(winnerId, "walkover", { challengeId: chId, title: "VICTORY BY WALKOVER!", message: "Your opponent did not check in within five minutes." });
  if (loserId) emitPlayer(loserId, "walkover", { challengeId: chId, title: "DEFEAT BY WALKOVER", message: "You did not check in within five minutes." });
}

function evaluate(chId) {
  const ch = state.challenges[chId], r = state.reports[chId] || {};
  if (!ch) return;
  const entries = Object.values(r);
  const a = r[ch.attackerId], d = r[ch.defenderId];
  if (a && d) {
    if (a.winnerId === d.winnerId) {
      resolve(chId, a.winnerId, "Both players reported the same winner; result automatically confirmed.");
      return;
    }
    ch.status = "disputed";
    ch.disputedAt = ch.disputedAt || Date.now();
    emitAdmins("battleDisputed", ch);
    io.emit("resultReported", { challenge: ch, reports: r });
    broadcast();
    return;
  }
  if (entries.length === 1) {
    ch.status = "reported";
    if (!ch.firstReportAt) ch.firstReportAt = entries[0].time;
    if (!ch.resultDeadline) ch.resultDeadline = ch.firstReportAt + 10 * 60 * 1000;
  }
  io.emit("resultReported", { challenge: ch, reports: r });
  emitAdmins("resultReportedAdmin", { challenge: ch, reports: r });
  broadcast();
}

setInterval(() => {
  const now = Date.now();
  let changed = regenerateDefensePoints();
  if (state.peaceTime?.endsAt && Number(state.peaceTime.endsAt) <= now) { state.peaceTime = { startedAt: null, endsAt: null, startedBy: null }; addNotice("Peace Time has ended. Territory challenges are available again."); io.emit("peaceTimeUpdated", state.peaceTime); changed = true; }
  if (tournamentHasEnded()) {
    for (const ch of Object.values(state.challenges)) {
      if (ch.status === "pending" || ch.status === "accepted") {
        delete state.challenges[ch.id]; delete state.reports[ch.id];
        io.emit("challengeCancelled", { challengeId: ch.id, territoryId: ch.territoryId, reason: "The 48-hour tournament has ended." }); changed = true;
      }
    }
  }
  for (const p of Object.values(state.players)) { const before = state.matchUsage.players[p.id]?.used; usageFor(p.id); if (before !== state.matchUsage.players[p.id]?.used) changed = true; }
  if (changed) broadcast();
  for (const ch of Object.values(state.challenges)) {
    if (ch.status === "pending" && now >= ch.expiresAt) expirePendingChallenge(ch.id);
    if (ch.status === "accepted" && ch.checkinExpiresAt && now >= ch.checkinExpiresAt) expireCheckin(ch.id);
    if (ch.status === "reported") {
      const entries = Object.values(state.reports[ch.id] || {});
      if (entries.length === 1) {
        const first = entries[0];
        const deadline = Number(ch.resultDeadline || first.time + 10 * 60 * 1000);
        if (now >= deadline && first.winnerId) resolve(ch.id, first.winnerId, "Opponent did not report a result within ten minutes; the submitted result was automatically confirmed.");
      }
    }
  }
}, 1000);

app.use(express.json());
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use(express.static(path.join(__dirname, "public")));

function clientIp(socket) {
  // Use proxy headers only when explicitly configured for a trusted reverse proxy.
  // Otherwise use the socket peer address to avoid trusting spoofed X-Forwarded-For values.
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = String(socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded.slice(0, 100);
  }
  return String(socket.handshake.address || "Unknown").replace(/^::ffff:/, "").slice(0, 100);
}

const geoCache = new Map();
function isPublicIp(ip) {
  if (!ip || ip === "Unknown" || ip === "127.0.0.1" || ip === "::1") return false;
  if (/^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}
function lookupIpLocation(ip) {
  return new Promise(resolve => {
    if (!isPublicIp(ip)) return resolve(null);
    if (geoCache.has(ip)) return resolve(geoCache.get(ip));
    const req = https.get(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { timeout: 3500, headers: { "User-Agent": "ReignOfTitanTournament/1.0" } }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          const lat = Number(d.latitude), lon = Number(d.longitude);
          const result = (!d.error && Number.isFinite(lat) && Number.isFinite(lon)) ? {
            city: String(d.city || "").slice(0, 100),
            region: String(d.region || "").slice(0, 100),
            country: String(d.country_name || d.country || "").slice(0, 100),
            latitude: lat, longitude: lon,
            source: "IP geolocation",
            updatedAt: Date.now()
          } : null;
          geoCache.set(ip, result); resolve(result);
        } catch { resolve(null) }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null) });
    req.on("error", () => resolve(null));
  });
}
async function updatePlayerGeo(playerId, ip) {
  const p = state.players[playerId]; if (!p || !isPublicIp(ip)) return;
  const location = await lookupIpLocation(ip);
  if (!location || !state.players[playerId]) return;
  // Avoid applying a slow response to a newer connection from another IP.
  if (state.players[playerId].lastIpAddress !== ip) return;
  state.players[playerId].ipLocation = location;
  save(state);
  emitAdmins("playerConnectionUpdated", { playerId, ipLocation: location });
}

function touchPlayerConnection(playerId, socket) {
  const p = state.players[playerId]; if (!p) return;
  p.lastIpAddress = clientIp(socket);
  p.lastSeenAt = Date.now();
  p.lastConnectedAt = Date.now();
  p.connectionCount = Math.max(0, Number(p.connectionCount || 0)) + 1;
  save(state);
  updatePlayerGeo(playerId, p.lastIpAddress).catch(() => { });
}

io.on("connection", socket => {
  socket.emit("state", publicState());
  socket.on("resume", id => {
    if (state.players[id]) { socket.data.playerId = id; touchPlayerConnection(id, socket); socket.emit("registered", { player: publicPlayer(state.players[id]), state: publicState() }); socket.emit("myMatchUsage", publicUsage(id)) }
    else socket.emit("resumeFailed")
  });

  socket.on("register", (d, cb) => {
    const riot = String(d?.riot || "").trim(), discord = String(d?.discord || "").trim();
    if (!riot || !discord) return cb?.({ ok: false, error: "Enter both your in-game name and Discord ID." });
    if (process.env.RENDER && !pgPool) return cb?.({ ok: false, error: "Permanent registration storage is not configured yet. Please contact the tournament admin before registering." });
    const norm = v => String(v || "").trim().toLowerCase();
    const existing = Object.values(state.players).find(p => norm(p.riot) === norm(riot) || norm(p.discord) === norm(discord));
    if (existing) { socket.data.playerId = existing.id; touchPlayerConnection(existing.id, socket); socket.emit("registered", { player: publicPlayer(existing), state: publicState() }); socket.emit("myMatchUsage", publicUsage(existing.id)); return cb?.({ ok: true, player: publicPlayer(existing), state: publicState(), existing: true }); }
    const id = crypto.randomUUID();
    state.players[id] = { id, name: riot, gmail: "", riot, discord, approved: false, approvalStatus: "pending", kingdom: null, slot: null, label: "Awaiting Approval", wins: 0, losses: 0, registeredAt: Date.now(), lastIpAddress: clientIp(socket), lastSeenAt: Date.now(), lastConnectedAt: Date.now(), connectionCount: 1 };
    state.playerOrder.push(id); socket.data.playerId = id; save(state);
    updatePlayerGeo(id, state.players[id].lastIpAddress).catch(() => { });
    cb?.({ ok: true, player: publicPlayer(state.players[id]), state: publicState(), existing: false }); socket.emit("myMatchUsage", publicUsage(id));
    io.emit("playerRegistered", publicPlayer(state.players[id])); broadcast();
  });

  socket.on("adminLogin", (credentials, cb) => {
    const id = typeof credentials === "object" ? credentials.id : "";
    const password = typeof credentials === "object" ? credentials.password : credentials;
    if (String(id) !== ADMIN_ID || String(password) !== ADMIN_PASSWORD) return cb?.({ ok: false, error: "Incorrect Admin ID or password." });
    socket.data.isAdmin = true; cb?.({ ok: true, state: adminState() });
  });
  socket.on("adminState", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    cb?.({ ok: true, state: adminState() });
  });
  socket.on("adminApprovePlayer", (playerId, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const p = state.players[playerId];
    if (!p) return cb?.({ ok: false, error: "Registration not found." });
    if (p.approved) return cb?.({ ok: true, alreadyApproved: true, state: adminState() });
    const approvedCount = Object.values(state.players).filter(x => x.approved !== false).length;
    if (approvedCount >= MAX_APPROVED_PLAYERS) return cb?.({ ok: false, error: "Player limit reached! A maximum of 30 players can be approved for this tournament." });
    p.approved = true; p.approvalStatus = "approved"; p.label = "Awaiting Kingdom Assignment";
    state.adminEvents = state.adminEvents || []; state.adminEvents.unshift({ time: Date.now(), action: "approvePlayer", playerId }); state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice(`${p.name} has been approved for the tournament.`);
    broadcast(); emitPlayer(playerId, "approvalUpdated", publicPlayer(p));
    cb?.({ ok: true, state: adminState() });
  });

  socket.on("adminAssign", (playerId, kingdomId, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const p = state.players[playerId];
    if (!p) return cb?.({ ok: false, error: "Player not found." });
    if (p.approved === false) return cb?.({ ok: false, error: "Approve this registration before assigning a Kingdom." });
    // In Waiting temporarily unassigns the player without deleting registration or history.
    if (kingdomId === "__waiting__") {
      if (!p.kingdom) return cb?.({ ok: false, error: "Player is already In Waiting." });
      const previousKingdom = K(p.kingdom);
      p.kingdom = null; p.slot = null; p.label = "In Waiting";
      state.adminEvents.unshift({ time: Date.now(), action: "unassignToWaiting", playerId, previousKingdom: previousKingdom?.id || null });
      state.adminEvents = state.adminEvents.slice(0, 200);
      addNotice(`${p.name} has been moved to In Waiting${previousKingdom ? ` from ${previousKingdom.name}` : ""}.`);
      broadcast(); cb?.({ ok: true, state: adminState() });
      emitPlayer(playerId, "assigned", publicPlayer(p));
      return;
    }
    const k = K(kingdomId);
    if (!k) return cb?.({ ok: false, error: "Player or Kingdom not found." });
    if (p.kingdom === kingdomId) return cb?.({ ok: false, error: "Player is already assigned to this Kingdom." });
    if (slotFor(kingdomId) === null) return cb?.({ ok: false, error: "That Kingdom already has 3 players." });
    // If reassigned, free the old slot naturally; labels of other players stay stable.
    const slot = slotFor(kingdomId);
    p.kingdom = kingdomId; p.slot = slot; p.label = labelFor(kingdomId, slot);
    state.adminEvents.unshift({ time: Date.now(), action: "assign", playerId, kingdomId });
    state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice(`${p.name} has been assigned to ${k.name}.`);
    broadcast(); cb?.({ ok: true, state: adminState() });
    emitPlayer(playerId, "assigned", publicPlayer(p));
  });
  socket.on("adminSetPlayerRecord", (payload, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const playerId = String(payload?.playerId || "");
    const player = state.players[playerId];
    if (!player) return cb?.({ ok: false, error: "Player not found." });
    const wins = Number(payload?.wins), losses = Number(payload?.losses);
    if (!Number.isSafeInteger(wins) || wins < 0 || !Number.isSafeInteger(losses) || losses < 0) {
      return cb?.({ ok: false, error: "Wins and losses must be whole numbers 0 or greater." });
    }
    const previous = { wins: Math.max(0, Number(player.wins) || 0), losses: Math.max(0, Number(player.losses) || 0) };
    player.wins = wins;
    player.losses = losses;
    state.adminEvents = state.adminEvents || [];
    state.adminEvents.unshift({ time: Date.now(), action: "setPlayerRecord", playerId, label: player.label || player.riot || player.name, previous, wins, losses });
    state.adminEvents = state.adminEvents.slice(0, 200);
    save(state);
    broadcast();
    cb?.({ ok: true, state: adminState() });
  });

  socket.on("adminRemovePlayer", (playerId, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const player = state.players[playerId]; if (!player) return cb?.({ ok: false, error: "Player not found." });
    for (const ch of Object.values(state.challenges)) if (ch.attackerId === playerId || ch.defenderId === playerId) { delete state.challenges[ch.id]; delete state.reports[ch.id]; io.emit("challengeCancelled", { challengeId: ch.id, territoryId: ch.territoryId }); }
    delete state.matchUsage.players[playerId]; delete state.players[playerId]; state.playerOrder = state.playerOrder.filter(id => id !== playerId);
    state.adminEvents.unshift({ time: Date.now(), action: "removePlayer", playerId, label: player.label || player.name }); state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice(`Admin removed ${player.label || player.name} from the active tournament.`); broadcast(); cb?.({ ok: true, state: adminState() });
  });
  socket.on("adminSetDefensePoints", (payload, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const kingdomId = String(payload?.kingdomId || "");
    const value = Number(payload?.points);
    const kingdom = K(kingdomId);
    if (!kingdom) return cb?.({ ok: false, error: "Kingdom not found." });
    if (!Number.isInteger(value) || value < 0 || value > 3) return cb?.({ ok: false, error: "Defense Points must be a whole number from 0 to 3." });
    state.defensePoints[kingdomId] = value;
    state.adminEvents = state.adminEvents || [];
    state.adminEvents.unshift({ time: Date.now(), action: "setDefensePoints", kingdomId, points: value });
    state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice(`Admin set ${kingdom.name} Defense Points to ${value}/3.`);
    broadcast();
    cb?.({ ok: true, state: adminState() });
  });

  socket.on("adminSetTerritoryOwner", (territoryId, kingdomId, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const t = state.territories.find(x => x.id === territoryId), k = K(kingdomId);
    if (!t || !k) return cb?.({ ok: false, error: "Territory or Kingdom not found." });
    const previous = t.kingdom;
    t.kingdom = kingdomId;
    t.adminOverrideAt = Date.now();
    t.adminOverrideFrom = previous;
    state.adminEvents.unshift({ time: Date.now(), action: "territoryOwnerOverride", territoryId, from: previous, to: kingdomId });
    state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice(`Admin changed Territory ${t.num} from ${K(previous)?.name || previous} to ${k.name}.`);
    broadcast();
    cb?.({ ok: true, state: adminState(), territory: t });
  });
  socket.on("adminStartTournament", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    if (state.tournamentStartedAt) return cb?.({ ok: false, error: "The tournament has already been started. Reset it only if you intentionally want to start a new tournament." });
    const approvedPlayers = Object.values(state.players).filter(p => p.approved !== false);
    if (approvedPlayers.length === 0) return cb?.({ ok: false, error: "Approve and assign players before starting the tournament." });
    if (approvedPlayers.some(p => !p.kingdom)) return cb?.({ ok: false, error: "Assign every approved player to a Kingdom before starting. Pending registrations do not need assignment." });
    state.tournamentStartedAt = Date.now(); state.tournamentStoppedAt = null; state.lastDefenseRegenAt = state.tournamentStartedAt;
    addNotice("The 48-hour Kingdom Catch Tournament has begun."); broadcast(); cb?.({ ok: true });
  });
  socket.on("adminRestartTournamentTimer", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    // Restart only the 48-hour clock. Preserve registrations, assignments, territory ownership,
    // Defense Points, match history, challenges, and personal match usage for safe testing.
    const now = Date.now();
    state.tournamentStartedAt = now;
    state.tournamentStoppedAt = null;
    state.lastDefenseRegenAt = now;
    state.adminEvents = state.adminEvents || [];
    state.adminEvents.unshift({ time: now, action: "restartTournamentTimer" });
    state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice("The admin restarted the 48-hour tournament timer.");
    save(state);
    broadcast();
    cb?.({ ok: true, state: adminState() });
  });

  socket.on("adminStopTournamentTimer", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    if (!state.tournamentStartedAt) return cb?.({ ok: false, error: "The tournament timer has not started yet." });
    if (state.tournamentStoppedAt) return cb?.({ ok: false, error: "The tournament timer is already stopped." });
    const now = Date.now();
    state.tournamentStoppedAt = now;
    state.adminEvents = state.adminEvents || [];
    state.adminEvents.unshift({ time: now, action: "stopTournamentTimer" });
    state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice("The admin stopped the 48-hour tournament timer. Challenges are paused until the timer is restarted.");
    save(state); broadcast(); cb?.({ ok: true, state: adminState() });
  });

  socket.on("adminStartPeaceTime", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const now = Date.now();
    if (!tournamentIsActive(now)) return cb?.({ ok: false, error: "Peace Time can only be started while the 48-hour tournament is active." });
    if (peaceTimeActive(now)) return cb?.({ ok: false, error: "Peace Time is already active." });
    state.peaceTime = { startedAt: now, endsAt: now + 10 * 60 * 60 * 1000, startedBy: ADMIN_ID };
    // Cancel only unanswered pending challenges; do not punish defenders for an admin-started truce.
    for (const ch of Object.values(state.challenges)) {
      if (ch.status === "pending") {
        delete state.challenges[ch.id]; delete state.reports[ch.id];
        io.emit("challengeCancelled", { challengeId: ch.id, territoryId: ch.territoryId, reason: "Peace Time started. No Defense Point penalty was applied." });
      }
    }
    state.adminEvents = state.adminEvents || []; state.adminEvents.unshift({ time: now, action: "startPeaceTime", endsAt: state.peaceTime.endsAt }); state.adminEvents = state.adminEvents.slice(0, 200);
    addNotice("PEACE TIME has started for 10 hours. All new territory challenges are disabled.");
    broadcast(); io.emit("peaceTimeUpdated", state.peaceTime); cb?.({ ok: true, state: adminState() });
  });
  socket.on("adminEndPeaceTime", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    state.peaceTime = { startedAt: null, endsAt: null, startedBy: null };
    addNotice("Peace Time was ended by the administrator. Territory challenges are available again.");
    broadcast(); io.emit("peaceTimeUpdated", state.peaceTime); cb?.({ ok: true, state: adminState() });
  });

  socket.on("adminResetTournament", cb => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    state = blankState(); save(state); io.emit("state", publicState()); cb?.({ ok: true });
  });

  socket.on("challengeCreate", (tid, cb) => {
    const now = Date.now();
    if (!state.tournamentStartedAt) return cb?.({ ok: false, error: "The tournament hasn't started yet. You cannot challenge or start matches until the admin starts the 48-hour tournament." });
    if (!tournamentIsActive(now)) return cb?.({ ok: false, error: "The 48-hour tournament has ended. New challenges are closed." });
    if (peaceTimeActive(now)) return cb?.({ ok: false, error: `PEACE TIME is active. No territory challenges are allowed for another ${Math.ceil(peaceTimeRemaining(now) / 60000)} minute(s).` });
    if (regenerateDefensePoints()) broadcast();
    const attacker = state.players[socket.data.playerId], t = state.territories.find(x => x.id === tid);
    if (!attacker || !t) return cb?.({ ok: false, error: "Invalid player or territory." });
    if (attacker.approved === false) return cb?.({ ok: false, error: "Your registration is still pending admin approval." });
    if (!attacker.kingdom) return cb?.({ ok: false, error: "Your Kingdom has not been assigned by the admin yet." });
    if (playerInMatch(attacker.id)) return cb?.({ ok: false, error: "You are already in a match." });
    if (t.kingdom === attacker.kingdom) return cb?.({ ok: false, error: "You cannot attack your own Kingdom." });
    if (activeChallengeForTerritory(tid)) return cb?.({ ok: false, error: "That territory is already under challenge." });
    // Territories may be attacked repeatedly. Only consecutive attacks against the same defending kingdom are restricted.
    if (state.lastOpponentByAttackingKingdom[attacker.kingdom] === t.kingdom) return cb?.({ ok: false, error: "Cannot challenge the same Kingdom consecutively. You must complete a match against a different Kingdom first." });
    const activeForDefendingKingdom = Object.values(state.challenges).filter(ch => ch.defenderKingdom === t.kingdom && ["pending", "accepted", "ready", "reported", "disputed"].includes(ch.status)).length;
    if (activeForDefendingKingdom >= 5) return cb?.({ ok: false, error: "This Kingdom already has 5 active challenges. Wait for one to be completed or cancelled before challenging it again." });
    if (!canStartMatch(attacker.id)) return cb?.({ ok: false, error: "You have used all 5 matches in your personal two-hour period." });
    const ch = {
      id: crypto.randomUUID(), territoryId: tid, attackerId: attacker.id, attackerKingdom: attacker.kingdom, defenderKingdom: t.kingdom, defenderId: null, status: "pending",
      createdAt: now, expiresAt: now + CHALLENGE_RESPONSE_MS, checkins: {}, chat: []
    };
    state.challenges[ch.id] = ch;
    addNotice(`${attacker.label} challenged Territory ${t.num} of ${K(t.kingdom).name}.`, t.kingdom);
    emitAdmins("challengeRequest", { challenge: ch, attacker: publicPlayer(attacker), territory: t, defenderKingdom: K(t.kingdom) });
    notifyKingdom(t.kingdom, "challengeIncoming", { challenge: ch, attacker: publicPlayer(attacker), territory: t, defenderKingdom: K(t.kingdom) });
    broadcast(); cb?.({ ok: true, challenge: ch });
  });
  socket.on("challengeCancel", (id, cb) => {
    const p = state.players[socket.data.playerId], ch = state.challenges[id];
    if (!p || !ch) return cb?.({ ok: false, error: "Challenge not found." });
    if (ch.status !== "pending") return cb?.({ ok: false, error: "Only a pending challenge can be cancelled." });
    if (ch.attackerId !== p.id) return cb?.({ ok: false, error: "Only the attacking player can cancel this challenge." });
    const t = state.territories.find(x => x.id === ch.territoryId);
    delete state.challenges[id]; delete state.reports[id];
    addNotice(`${p.label} cancelled the challenge for Territory ${t?.num || "?"}.`);
    io.emit("challengeCancelled", { challengeId: id, territoryId: ch.territoryId });
    broadcast(); cb?.({ ok: true });
  });
  socket.on("challengeDecline", (id, cb) => {
    const p = state.players[socket.data.playerId], ch = state.challenges[id];
    if (!p || !ch || ch.status !== "pending") return cb?.({ ok: false, error: "This challenge is no longer pending." });
    if (p.approved === false || p.kingdom !== ch.defenderKingdom) return cb?.({ ok: false, error: "Only an approved member of the defending Kingdom can decline." });
    ch.declinedBy = Array.isArray(ch.declinedBy) ? ch.declinedBy : [];
    if (!ch.declinedBy.includes(p.id)) ch.declinedBy.push(p.id);
    const defenders = Object.values(state.players).filter(x => x.approved !== false && x.kingdom === ch.defenderKingdom);
    const allDeclined = defenders.length >= 3 && defenders.slice(0, 3).every(x => ch.declinedBy.includes(x.id));
    if (allDeclined) {
      ch.allDefendersDeclined = true;
      applyDefensiveFailure(ch, "all three defenders declined the challenge");
      cb?.({ ok: true, allDeclined: true, defensePoints: state.defensePoints[ch.defenderKingdom] ?? 3 });
      return;
    }
    addNotice(`${p.label} declined a challenge. Other defenders can still accept it.`, ch.defenderKingdom);
    broadcast();
    cb?.({ ok: true, allDeclined: false, declinedCount: ch.declinedBy.length, defendersRequired: 3 });
  });
  socket.on("challengeAccept", (id, cb) => {
    const now = Date.now();
    if (peaceTimeActive(now)) return cb?.({ ok: false, error: `PEACE TIME is active. Challenge acceptance is paused for another ${Math.ceil(peaceTimeRemaining(now) / 60000)} minute(s).` });
    if (!tournamentIsActive(now)) return cb?.({ ok: false, error: !state.tournamentStartedAt ? "The tournament hasn't started yet. You cannot start matches until the admin starts the 48-hour tournament." : "The 48-hour tournament has ended. New matches are closed." });
    const p = state.players[socket.data.playerId], ch = state.challenges[id];
    if (!p || !ch) return cb?.({ ok: false, error: "Challenge not found." });
    if (ch.status !== "pending") return cb?.({ ok: false, error: "This challenge is no longer waiting for acceptance." });
    if (now >= ch.expiresAt) { expirePendingChallenge(ch.id); return cb?.({ ok: false, error: "The 15-minute challenge response window has expired." }); }
    if (p.approved === false) return cb?.({ ok: false, error: "Your registration is still pending admin approval." });
    if (p.kingdom !== ch.defenderKingdom) return cb?.({ ok: false, error: "Only an approved player from the defending Kingdom can accept." });
    if (playerInMatch(p.id)) return cb?.({ ok: false, error: "You are already in a match." });
    if (playerInMatch(ch.attackerId, ch.id)) return cb?.({ ok: false, error: "The challenger is already in another match." });
    if (!canStartMatch(ch.attackerId)) return cb?.({ ok: false, error: "The challenger has reached their personal match limit." });
    ch.defenderId = p.id; ch.status = "accepted"; ch.acceptedAt = now; ch.checkinExpiresAt = now + CHECKIN_WINDOW_MS;
    addNotice(`${p.label} accepted a territory challenge.`);
    emitAdmins("challengeAcceptedAdmin", { challenge: ch, defender: publicPlayer(p) });
    broadcast(); io.emit("challengeAccepted", ch); cb?.({ ok: true, challenge: ch });
  });
  socket.on("checkin", (id, cb) => {
    if (!tournamentIsActive()) return cb?.({ ok: false, error: !state.tournamentStartedAt ? "The tournament hasn't started yet." : "The 48-hour tournament has ended. Check-in is closed." });
    const p = state.players[socket.data.playerId], ch = state.challenges[id];
    if (!p || !ch || ![ch.attackerId, ch.defenderId].includes(p.id)) return cb?.({ ok: false, error: "You are not part of this battle." });
    if (ch.status !== "accepted" && ch.status !== "ready") return cb?.({ ok: false, error: "Check-in is not open for this challenge." });
    if (ch.checkins[p.id]) return cb?.({ ok: true, alreadyCheckedIn: true, challenge: ch, matchStarted: ch.status === "ready" });
    if (ch.checkinExpiresAt && Date.now() >= ch.checkinExpiresAt) return cb?.({ ok: false, error: "The five-minute check-in window has expired." });
    ch.checkins[p.id] = Date.now();
    if (ch.checkins[ch.attackerId] && ch.checkins[ch.defenderId]) {
      const usage = startMatchUsage([ch.attackerId]);
      if (!usage.ok) { delete ch.checkins[p.id]; return cb?.({ ok: false, error: "A player has reached their personal match limit. The match cannot start." }); }
      ch.status = "ready"; ch.matchStartedAt = Date.now();
      addNotice(`${state.players[ch.attackerId]?.label || "Attacker"} and ${state.players[ch.defenderId]?.label || "Defender"} both checked in. Match started.`);
    }
    broadcast(); io.emit("challengeUpdated", ch); cb?.({ ok: true, matchStarted: ch.status === "ready" });
  });
  socket.on("reportResult", (id, result, cb) => {
    if (!tournamentIsActive()) return cb?.({ ok: false, error: "The tournament is not active. Result reporting is closed." });
    const p = state.players[socket.data.playerId], ch = state.challenges[id];
    if (!p || !ch || !ch.defenderId) return cb?.({ ok: false, error: "Battle is not accepted yet." });
    if (!ch.checkins[ch.attackerId] || !ch.checkins[ch.defenderId]) return cb?.({ ok: false, error: "Both players must check in first." });
    if (!["win", "loss"].includes(result)) return cb?.({ ok: false, error: "Invalid result." });
    if (!["ready", "reported", "disputed"].includes(ch.status)) return cb?.({ ok: false, error: "This result can no longer be changed." });
    state.reports[id] = state.reports[id] || {};
    const now = Date.now();
    const existing = state.reports[id][p.id];
    // If the only report's 10-minute deadline has already passed, finalize it before accepting a late response.
    const currentEntries = Object.entries(state.reports[id]);
    if (ch.status === "reported" && currentEntries.length === 1 && currentEntries[0][0] !== p.id && now >= Number(ch.resultDeadline || currentEntries[0][1].time + 10 * 60 * 1000)) {
      resolve(id, currentEntries[0][1].winnerId, "Opponent did not report a result within ten minutes; the submitted result was automatically confirmed.");
      return cb?.({ ok: false, error: "The reporting deadline expired and the other player's result was already finalized." });
    }
    const winnerId = result === "win" ? p.id : (p.id === ch.attackerId ? ch.defenderId : ch.attackerId);
    state.reports[id][p.id] = { result, winnerId, time: now, updated: !!existing };
    if (ch.status !== "disputed") ch.status = "reported";
    if (!ch.firstReportAt) ch.firstReportAt = now;
    if (Object.keys(state.reports[id]).length === 1 && !ch.resultDeadline) ch.resultDeadline = now + 10 * 60 * 1000;
    evaluate(id); broadcast(); cb?.({ ok: true, updated: !!existing });
  });
  socket.on("chat", (id, message, cb) => {
    const p = state.players[socket.data.playerId], ch = state.challenges[id];
    if (!p || !ch || ![ch.attackerId, ch.defenderId].includes(p.id)) return cb?.({ ok: false, error: "Chat is limited to battle participants." });
    const text = String(message || "").trim().slice(0, 500); if (!text) return;
    const msg = { id: crypto.randomUUID(), playerId: p.id, label: p.label, text, time: Date.now() };
    ch.chat = ch.chat || []; ch.chat.push(msg); ch.chat = ch.chat.slice(-100);
    [ch.attackerId, ch.defenderId].forEach(pid => emitPlayer(pid, "chatMessage", { challengeId: id, message: msg }));
    save(state); cb?.({ ok: true });
  });
  socket.on("adminResolve", (id, winnerId, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const ch = state.challenges[id];
    if (!ch || !["reported", "disputed"].includes(ch.status)) return cb?.({ ok: false, error: "This battle is not awaiting an admin decision." });
    if (![ch.attackerId, ch.defenderId].includes(winnerId)) return cb?.({ ok: false, error: "Winner must be one of the two players." });
    resolve(id, winnerId, "Admin approved the result.");
    cb?.({ ok: true });
  });
  socket.on("adminDenyReport", (id, playerId, cb) => {
    if (!socket.data.isAdmin) return cb?.({ ok: false, error: "Admin authentication required." });
    const ch = state.challenges[id], r = state.reports[id] || {};
    if (!ch || !["reported", "disputed"].includes(ch.status)) return cb?.({ ok: false, error: "This battle is not awaiting an admin decision." });
    if (!r[playerId]) return cb?.({ ok: false, error: "That player has not submitted a result." });
    delete r[playerId];
    if (Object.keys(r).length === 0) { ch.status = "ready"; delete state.reports[id]; }
    else { ch.status = "reported"; ch.firstReportAt = Object.values(r).sort((a, b) => a.time - b.time)[0].time; }
    addNotice(`Admin denied a result report for ${ch.id}.`);
    emitAdmins("reportDenied", { challenge: ch, playerId });
    broadcast(); cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const playerId = socket.data.playerId;
    if (playerId && state.players[playerId]) {
      state.players[playerId].lastSeenAt = Date.now();
      save(state);
      emitAdmins("playerConnectionUpdated", { playerId, lastSeenAt: state.players[playerId].lastSeenAt });
    }
  });
});

app.get("/api/health", (req, res) => res.json({ ok: pgPool ? (databaseReady && !databaseLastError) : !process.env.RENDER, version: 3, storage: pgPool ? "postgresql" : "local-json-not-durable", databaseReady: !!(pgPool && databaseReady), persistenceError: databaseLastError }));

// Admin-protected data endpoints — view database in browser
// Usage: /api/admin/data?id=kamleshhhh&pass=kamlesh078
function adminAuth(req, res, next) {
  const id = req.query.id, pass = req.query.pass;
  if (id !== ADMIN_ID || pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Admin authentication required. Use ?id=YOUR_ADMIN_ID&pass=YOUR_ADMIN_PASSWORD" });
  next();
}
app.get("/api/admin/data", adminAuth, (req, res) => {
  res.json({
    storage: pgPool ? "postgresql" : "local-json",
    databaseReady: !!(pgPool && databaseReady),
    totalPlayers: Object.keys(state.players).length,
    approvedPlayers: Object.values(state.players).filter(p => p.approved !== false).length,
    pendingPlayers: Object.values(state.players).filter(p => p.approvalStatus === "pending").length,
    totalTerritories: state.territories.length,
    tournamentStartedAt: state.tournamentStartedAt,
    tournamentStoppedAt: state.tournamentStoppedAt,
    activeChallenges: Object.keys(state.challenges).length,
    completedBattles: (state.completedBattles || []).length,
    fullState: state
  });
});
app.get("/api/admin/players", adminAuth, (req, res) => {
  const players = Object.entries(state.players).map(([id, p]) => ({
    id, name: p.name, riot: p.riot, discord: p.discord, gmail: p.gmail,
    kingdom: p.kingdom, slot: p.slot, label: p.label,
    wins: p.wins, losses: p.losses,
    approved: p.approved, approvalStatus: p.approvalStatus,
    registeredAt: p.registeredAt, lastSeenAt: p.lastSeenAt,
    lastIpAddress: p.lastIpAddress, ipLocation: p.ipLocation
  }));
  res.json({ totalPlayers: players.length, players });
});
app.get("/api/admin/territories", adminAuth, (req, res) => {
  res.json({ totalTerritories: state.territories.length, territories: state.territories });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
initializePersistentStorage().then(() => {
  server.listen(PORT, () => console.log(`Kingdom Conquest running on port ${PORT}`));
}).catch(err => {
  console.error("Could not initialize persistent database. Server will not start to avoid losing registrations:", err);
  process.exitCode = 1;
  server.close(() => {});
  if (pgPool) pgPool.end().catch(() => {});
});
