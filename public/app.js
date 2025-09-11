import { verifyCardAssets } from './cards.js';
import { Debug } from './debug.js';
import { evalTexas7, evalOmaha, compareHands } from './poker-eval.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  getFirestore, doc, runTransaction, onSnapshot,
  serverTimestamp, updateDoc, writeBatch, getDoc, setDoc,
  collection, addDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const BUILD_TAG = "UI-RED-v1";

const PRESENCE = {
  HEARTBEAT_MS: 10_000,
  STALE_AFTER_MS: 45_000,
  SWEEP_INTERVAL_MS: 15_000,
  LOCK_TTL_MS: 20_000
};

const DEAL_LOCK = {
  TTL_MS: 5000,
  SWEEP_INTERVAL_MS: 3000
};

const DEFAULT_CONFIG = { sb: 25, bb: 50, startingStack: 10000 };

const params = new URLSearchParams(location.search);
const initialRoom = params.get('room');
if (!initialRoom) {
  location.replace('/');
}

let roomCode = null;
let heartbeatTimer = null;
let sweeperTimer = null;
let dealLockSweeperTimer = null;
let currentRoomRef = null;
let currentRoom = null;
let derivedDealerSeat = null;
let activeSeated = 0;
let totalSeated = 0;
let lastGateReason = null;
let dealFlowRunning = false;
let myHandUnsub = null;
let myHandId = null;
let myHandCards = null;
let upcomingDealerPid = null;

const rankOffset = {2:0,3:1,4:2,5:3,6:4,7:5,8:6,9:7,10:8,J:9,Q:10,K:11,A:12};
const baseBySuit = { D:1, C:14, H:27, S:40 };
function resolveCardSrc(rank, suit){
  const index = baseBySuit[suit] + rankOffset[rank];
  return `/Images/Card_Deck-${String(index).padStart(2,'0')}.png`;
}
const CARD_BACK = '/Images/Card_Deck-Back.png';
function indexToRankSuit(i){
  if (i<14) return {s:'D', r:[2,3,4,5,6,7,8,9,10,'J','Q','K','A'][i-1]};
  if (i<27) return {s:'C', r:[2,3,4,5,6,7,8,9,10,'J','Q','K','A'][i-14]};
  if (i<40) return {s:'H', r:[2,3,4,5,6,7,8,9,10,'J','Q','K','A'][i-27]};
  return {s:'S', r:[2,3,4,5,6,7,8,9,10,'J','Q','K','A'][i-40]};
}
function cardImgByIndex(i){
  const {s,r} = indexToRankSuit(i);
  const src = resolveCardSrc(r,s);
  const img = new Image();
  img.src = src;
  img.alt = `${r}${s}`;
  return img;
}


const debug = new Debug({
  roomCodeGetter: () => roomCode,
  playerIdGetter: () => window.APP?.playerId || null
});
window.DEBUG = debug;

debug.log('app.init', { ua: navigator.userAgent });
debug.log('ui.debug.ready', { panel: 'open' });

const buildTagEl = document.getElementById('build-tag');
if (buildTagEl) buildTagEl.textContent = BUILD_TAG;
debug.log('app.build', { tag: BUILD_TAG });

const firebaseConfig = {
  apiKey: "AIzaSyDW9Subu-SEcSoe-uHNT8FzazZhgRknOHg",
  authDomain: "jamcasino-36b9a.firebaseapp.com",
  projectId: "jamcasino-36b9a",
  storageBucket: "jamcasino-36b9a.firebasestorage.app",
  messagingSenderId: "173219554638",
  appId: "1:173219554638:web:597524a6a30e71f3a2aa1f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let walletBalance = 0;

async function ensureWallet(uid){
  const wRef = doc(db,'wallets',uid);
  const snap = await getDoc(wRef);
  if(!snap.exists()){
    await setDoc(wRef,{ balance:100, createdAt:serverTimestamp(), updatedAt:serverTimestamp() });
    walletBalance = 100;
    debug.log('wallet.init',{ balance:100 });
  }else{
    walletBalance = snap.data().balance || 0;
  }
}

// Returns a Promise<string> of the assigned display name, e.g. "Player3".
async function ensureRoomDisplayName(db, roomRef, uid) {
  const rx = /^Player(\d+)$/;
  let assigned = null;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error('Room missing');
    const room = snap.data() || {};
    const players = room.players || {};

    const mine = players[uid] || {};
    if (mine.displayName && rx.test(mine.displayName)) {
      assigned = mine.displayName;
      return;
    }

    const used = new Set();
    Object.values(players).forEach(p => {
      if (p && typeof p.displayName === 'string') {
        const m = p.displayName.match(rx);
        if (m) used.add(parseInt(m[1], 10));
      }
    });

    let n = 1;
    while (used.has(n)) n++;
    assigned = `Player${n}`;
    const path = `players.${uid}.displayName`;
    tx.update(roomRef, { [path]: assigned });
  });

  window.DEBUG?.log('name.assign.success', { displayName: assigned });
  return assigned;
}

await setPersistence(auth, browserSessionPersistence);
await signInAnonymously(auth);

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  window.APP = window.APP || {};
  window.APP.playerId = user.uid;

  const playerSpan = document.getElementById('player-id');
  if (playerSpan) playerSpan.textContent = user.uid;

  await ensureWallet(user.uid);
  if (initialRoom) {
    await joinRoomByCode(initialRoom.toUpperCase());
  }
  window.DEBUG?.log('firebase.init.ok', { appName: app.name });
  window.DEBUG?.log('auth.anon.signIn.success', { uid: user.uid, persistence: 'session' });
  window.DEBUG?.log('auth.state', { uid: user.uid });
});

  const assetBtn = document.getElementById('btn-asset-check');
  if (assetBtn) assetBtn.addEventListener('click', () => {
    verifyCardAssets();
  });

  const leaveBtn = document.getElementById('btn-leave');
  if (leaveBtn) {
    leaveBtn.onclick = async () => {
      try {
        await safeUnseatAndCreditIfIdle();
      } catch(_) {}
      debug.log('nav.table.leave', { roomCode });
      location.href = '/';
    };
  }

// --- Gated controls ---
const prefEl = document.getElementById('variant-pref');
const variantLockedChip = document.getElementById('variant-locked-chip');
const headerEl = document.querySelector('header');
let nextStreetBtn = document.getElementById('btn-next-street');
if (!nextStreetBtn) {
  nextStreetBtn = document.createElement('button');
  nextStreetBtn.id = 'btn-next-street';
  nextStreetBtn.disabled = true;
  nextStreetBtn.title = 'Dealer only';
  nextStreetBtn.textContent = 'Next Street';
  const labelEl = prefEl?.parentNode || null;
  if (labelEl && labelEl.parentNode) {
    labelEl.parentNode.insertBefore(nextStreetBtn, labelEl);
  } else {
    headerEl?.appendChild(nextStreetBtn);
  }
}
let settleBtn = document.getElementById('btn-settle');
if (!settleBtn) {
  settleBtn = document.createElement('button');
  settleBtn.id = 'btn-settle';
  settleBtn.disabled = true;
  settleBtn.title = 'Settle at showdown';
  settleBtn.textContent = 'Settle Hand';
  headerEl?.appendChild(settleBtn);
}

document.querySelectorAll('.seat').forEach((el, idx) => {
  el.addEventListener('click', () => handleSeatClick(idx));
});
const lockInfoEl = document.createElement('span');
lockInfoEl.id = 'lock-info';
lockInfoEl.className = 'lock-info';
headerEl?.appendChild(lockInfoEl);

const foldBtn = document.getElementById('btn-fold');
const callBtn = document.getElementById('btn-call');
const betInput = document.getElementById('bet-amount');
const raiseBtn = document.getElementById('btn-raise');
const turnHint = document.getElementById('turn-hint');
const myConsole = document.getElementById('my-console');

function renderMyConsole(name) {
  const el = document.getElementById('my-name');
  if (el) el.textContent = name;
}

const potEl = document.getElementById('pot-pill');

const uiDealLock = { active: false, timer: null, startAt: 0, TTL_MS: 3000 };
function setUiDealLock(on) {
  if (on) {
    if (uiDealLock.active) return;
    uiDealLock.active = true;
    uiDealLock.startAt = Date.now();
    window.DEBUG?.log('hand.lock.ui.set', { ttl: uiDealLock.TTL_MS });
    uiDealLock.timer = setTimeout(() => autoReleaseUiDealLock('timeout'), uiDealLock.TTL_MS);
    evaluateAndRenderGate();
  } else {
    if (!uiDealLock.active) return;
    clearTimeout(uiDealLock.timer);
    uiDealLock.active = false;
    uiDealLock.timer = null;
    window.DEBUG?.log('hand.lock.ui.release', { manual: true });
    evaluateAndRenderGate();
  }
}

function autoReleaseUiDealLock(reason, skipEval = false) {
  if (!uiDealLock.active) return;
  clearTimeout(uiDealLock.timer);
  uiDealLock.active = false;
  uiDealLock.timer = null;
  window.DEBUG?.log('hand.lock.ui.autorelease', { reason });
  if (!skipEval) evaluateAndRenderGate();
}

function maybeAutoReleaseUiDealLock(room) {
  if (!uiDealLock.active) return;
  const now = Date.now();
  if (room.state === 'dealLocked') {
    autoReleaseUiDealLock('snapshot', true);
  } else if (room.state === 'idle' && (now - uiDealLock.startAt) > 1000) {
    autoReleaseUiDealLock('timeout', true);
  }
}

function countActivePlayers(room, nowMs, myUid) {
  const players = room?.players || {};
  let active = 0;
  let total = 0;
  for (const [pid, p] of Object.entries(players)) {
    const seat = typeof p?.seat === 'number' ? p.seat : null;
    if (seat == null) continue;
    total++;
    const last = p?.lastSeen?.toMillis?.();
    const isActive = (p?.active === true && last != null && (nowMs - last) <= PRESENCE.STALE_AFTER_MS) ||
      (pid === myUid && last == null);
    if (isActive) active++;
  }
  return { activeSeated: active, totalSeated: total };
}

function deriveDealerSeat(room) {
  const { players = {} } = room || {};
  const candidates = [];
  for (const p of Object.values(players)) {
    const seat = typeof p?.seat === 'number' ? p.seat : null;
    if (seat == null) continue;
    const joined = p?.joinedAt?.toMillis?.();
    const lastSeen = p?.lastSeen?.toMillis?.();
    let ts = Number.MAX_SAFE_INTEGER;
    let source = 'seatFallback';
    if (typeof joined === 'number') { ts = joined; source = 'joinedAt'; }
    else if (typeof lastSeen === 'number') { ts = lastSeen; source = 'lastSeen'; }
    candidates.push({ seat, ts, source });
  }
  if (!candidates.length) return { seat: null, source: 'seatFallback' };
  candidates.sort((a, b) => a.ts === b.ts ? a.seat - b.seat : a.ts - b.ts);
  const best = candidates[0];
  const tie = candidates.length > 1 && candidates[1].ts === best.ts;
  const src = (best.ts === Number.MAX_SAFE_INTEGER || tie) ? 'seatFallback' : best.source;
  return { seat: best.seat, source: src };
}

function computeDealGate(room, myUid, uiLockActive) {
  const now = Date.now();
  const { activeSeated, totalSeated } = countActivePlayers(room, now, myUid);
  const state = room?.state || null;
  const handStatus = room?.hand?.status || null;
  let derivedSeat = null;
  let upcomingSeat = null;
  if (state === 'hand' || state === 'dealLocked') {
    const currentSeat = room.hand?.dealerSeat ?? (typeof room?.dealerSeat === 'number' ? room.dealerSeat : deriveDealerSeat(room).seat);
    derivedSeat = currentSeat;
    upcomingSeat = nextOccupiedLeftOf(currentSeat, room.seats || []);
    window.DEBUG?.log('dealer.compute', { derivedSeat: currentSeat, source: 'hand', upcomingSeat });
  } else if (typeof room?.dealerSeat === 'number') {
    derivedSeat = room.dealerSeat;
    upcomingSeat = room.dealerSeat;
    window.DEBUG?.log('dealer.compute', { derivedSeat, source: 'room.dealerSeat' });
  } else {
    const { seat, source } = deriveDealerSeat(room);
    derivedSeat = seat;
    upcomingSeat = seat;
    window.DEBUG?.log('dealer.compute', { derivedSeat: seat, source });
  }
  const upcomingPid = room.seats?.[upcomingSeat] || null;
  const mySeat = room.players?.[myUid]?.seat ?? null;
  const isDealer = mySeat != null && derivedSeat != null && mySeat === derivedSeat;
  const lockedVariant = room.nextVariant?.value || null;
  const reasons = [];
  if (state === 'dealLocked') reasons.push('lockHeld');
  if (state !== 'idle') reasons.push('notIdle');
  if (!lockedVariant) reasons.push('noVariant');
  if (activeSeated < 2) reasons.push('players<2');
  if (!isDealer) reasons.push('notDealer');
  if (uiLockActive) reasons.push('uiLock');
  const eligible = reasons.length === 0;
  return {
    eligible,
    reasons,
    derivedDealerSeat: derivedSeat,
    upcomingDealerPid: upcomingPid,
    isDealer,
    activeSeated,
    totalSeated,
    state,
    handStatus,
    lockedVariant
  };
}

function isLockExpired(hand, nowMs) {
  const atMs = hand?.lockedAt?.toMillis?.() ?? 0;
  const ttl = hand?.lockTTLms ?? DEAL_LOCK.TTL_MS;
  return nowMs - atMs > ttl;
}

function xorshift32(seed) {
  let x = seed >>> 0;
  return function() {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 0x100000000; // [0,1)
  };
}

function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function shuffledDeck(seedStr) {
  const rand = xorshift32(seedFromString(seedStr));
  const deck = Array.from({ length: 52 }, (_, i) => i + 1);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function nextOccupiedLeftOf(seat, seats = []) {
  const N = seats.length;
  for (let k = 1; k <= N; k++) {
    const idx = (seat + k) % N;
    if (seats[idx]) return idx;
  }
  return seat;
}

function reconstructHoleCards(room, hand) {
  const deck = shuffledDeck(`${room.code}:${hand.id}`);
  const participants = hand.participants || [];
  const seats = room.seats || [];
  const order = [];
  const seen = new Set();
  for (let i = 1; i <= 9; i++) {
    const idx = (hand.dealerSeat + i) % 9;
    const pid = seats[idx];
    if (pid && participants.includes(pid) && !seen.has(pid)) {
      order.push(pid);
      seen.add(pid);
    }
  }
  const dealt = {};
  let ptr = 0;
  for (let r = 0; r < hand.holeCount; r++) {
    for (const pid of order) {
      if (!dealt[pid]) dealt[pid] = [];
      dealt[pid].push(deck[ptr++]);
    }
  }
  return dealt;
}

function buildSidePots(contribMap = {}, inMap = {}) {
  const entries = Object.entries(contribMap).filter(([, v]) => v > 0);
  if (!entries.length) return [];
  const remain = Object.fromEntries(entries);
  const pots = [];
  while (true) {
    const activePids = Object.keys(remain).filter(pid => remain[pid] > 0);
    if (!activePids.length) break;
    const floor = Math.min(...activePids.map(pid => remain[pid]));
    const layerPids = activePids;
    const layerAmt = floor * layerPids.length;
    const eligibles = layerPids.filter(pid => inMap[pid] === true);
    pots.push({ amount: layerAmt, eligibles });
    layerPids.forEach(pid => { remain[pid] -= floor; });
  }
  return pots;
}

function computeBoardNext(room, hand) {
  const N = (hand.participants || []).length;
  const holeCount = hand.holeCount || (hand.variant === 'OMA' ? 4 : 2);
  const consumedHole = N * holeCount;

  const deck = shuffledDeck(`${room.code}:${hand.id}`);

  let cp = consumedHole;

  const flopBurn = deck[cp++];
  const flop = [deck[cp++], deck[cp++], deck[cp++]];

  const turnBurn = deck[cp++];
  const turn = deck[cp++];

  const riverBurn = deck[cp++];
  const river = deck[cp++];

  const already = (hand.board || []).length;
  if (already === 0) return { nextStatus: 'flop', toAppend: flop, revealCount: 3 };
  if (already === 3) return { nextStatus: 'turn', toAppend: [turn], revealCount: 1 };
  if (already === 4) return { nextStatus: 'river', toAppend: [river], revealCount: 1 };

  return { nextStatus: null, toAppend: [], revealCount: 0 };
}

function computeOrder(room, street) {
  const { seats = [], hand = {} } = room || {};
  const participants = hand.participants || [];
  const occupied = (idx) => {
    const pid = seats[idx];
    return pid && participants.includes(pid);
  };
  const nextOccupied = (start) => {
    for (let k = 1; k <= 9; k++) {
      const s = (start + k) % 9;
      if (occupied(s)) return s;
    }
    return null;
  };

  const dealerSeat = hand.dealerSeat;
  if (dealerSeat == null) return [];

  const sbSeat = nextOccupied(dealerSeat);
  const bbSeat = nextOccupied(sbSeat ?? dealerSeat);

  const n = participants.length;
  let startSeat;
  if (street === 'preflop') {
    if (n === 2) {
      startSeat = dealerSeat;
    } else {
      startSeat = nextOccupied(bbSeat ?? dealerSeat);
    }
  } else {
    startSeat = nextOccupied(dealerSeat);
  }

  if (startSeat == null) return [];

  const order = [];
  let s = startSeat;
  for (let i = 0; i < 9; i++) {
    const pid = seats[s];
    if (pid && participants.includes(pid)) order.push(pid);
    s = (s + 1) % 9;
    if (s === startSeat && order.length) break;
  }
  return order;
}

async function tryTxDealLock(db, roomRef, uid) {
  const nowMs = Date.now();
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw { code: 'ROOM_MISSING' };
    const room = snap.data();

    if (room.state && room.state !== 'idle') {
      if (room.state === 'dealLocked' && room.hand?.status === 'locked') {
        if (room.hand.lockedBy === uid && !isLockExpired(room.hand, nowMs)) {
          return { type: 'IDEMPOTENT', handId: room.hand.id };
        }
        if (!isLockExpired(room.hand, nowMs)) {
          throw { code: 'LOCK_HELD', handId: room.hand.id };
        }
      } else {
        throw { code: 'NOT_IDLE' };
      }
    }

    const locked = room.nextVariant?.value;
    if (!locked) throw { code: 'NO_VARIANT_LOCKED' };

    const dealerSeat = (typeof room.dealerSeat === 'number') ? room.dealerSeat : deriveDealerSeat(room).seat;
    const dealerPid = room.seats?.[dealerSeat] ?? null;
    if (uid !== room.nextVariant?.dealerPid || dealerPid !== room.nextVariant?.dealerPid) throw { code: 'NOT_DEALER' };

    const { activeSeated } = countActivePlayers(room, nowMs, uid);
    if (activeSeated < 2) throw { code: 'PLAYERS_LT_2', activeSeated };

    const handId = `${Date.now()}_${uid.slice(0,6)}_${Math.floor(Math.random()*1e4)}`;
    const hand = {
      id: handId,
      status: 'locked',
      variant: locked,
      dealerSeat,
      dealerPid,
      lockedBy: uid,
      lockedAt: serverTimestamp(),
      lockTTLms: DEAL_LOCK.TTL_MS
    };

    tx.update(roomRef, {
      state: 'dealLocked',
      hand
    });

    return { type: 'LOCKED', handId };
  });
}

async function sweepExpiredDealLock(db, roomRef) {
  const nowMs = Date.now();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const room = snap.data();
      if (room.state !== 'dealLocked' || room.hand?.status !== 'locked') return;

      if (isLockExpired(room.hand, nowMs)) {
        tx.update(roomRef, {
          state: 'idle',
          hand: null
        });
        throw { code: 'RELEASED' };
      }
    });
  } catch (e) {
    if (e.code === 'RELEASED') {
      window.DEBUG?.log('hand.lock.sweeper.release.success', {});
    }
  }

  const betState = data.hand?.betting || {};
  if (potEl) potEl.textContent = `Pot: ${betState.pot || 0}`;
  window.DEBUG?.log('ui.betting.render', {
    pot: betState.pot || 0,
    currentBet: betState.currentBet || 0,
    minRaiseTo: betState.minRaiseTo || 0
  });
}

function renderGatedControls(gate, firstReason) {
  const state = gate.state;
  const handStatus = gate.handStatus;
  const isDealer = gate.isDealer;
  lastGateReason = firstReason;

  if (prefEl) {
    const prefPid = gate.upcomingDealerPid;
    const prefVal = currentRoom?.players?.[prefPid]?.variantPref;
    prefEl.value = prefVal === 'OMA' ? 'OMA' : 'HE';
    const enabled = auth.currentUser?.uid === prefPid && (state === 'hand' || (state === 'idle' && !currentRoom?.nextVariant));
    prefEl.disabled = !enabled;
    prefEl.title = enabled ? 'Select variant preference' : 'Upcoming dealer only';
  }
  if (variantLockedChip) {
    if (currentRoom?.nextVariant?.value) {
      variantLockedChip.textContent = currentRoom.nextVariant.value === 'OMA' ? 'Omaha' : 'Texas';
      variantLockedChip.classList.remove('hidden');
    } else {
      variantLockedChip.classList.add('hidden');
    }
  }
  window.DEBUG?.log('ui.variant.render', { locked: currentRoom?.nextVariant?.value || null, enabledForPid: gate.upcomingDealerPid });

  if (nextStreetBtn) {
    let nsReason = null;
    if (uiDealLock.active) nsReason = 'uiLock';
    else if (state !== 'hand') nsReason = 'noHand';
    else if (!isDealer) nsReason = 'notDealer';
    else if (!['preflop', 'flop', 'turn'].includes(handStatus)) nsReason = 'complete';
    else {
      const bet = currentRoom?.hand?.betting;
      const allInClosed = bet ? Object.entries(bet.in || {}).filter(([p, v]) => v).every(([pid]) => bet.allIn?.[pid]) : false;
      if (!(bet?.roundClosed || allInClosed)) nsReason = 'roundOpen';
      else if (currentRoom?.hand?.turn?.street !== handStatus) nsReason = 'turnMismatch';
    }

    nextStreetBtn.disabled = nsReason !== null;
    let nsTitle = '';
    if (nsReason === 'notDealer') nsTitle = 'Dealer only';
    else if (nsReason === 'noHand') nsTitle = 'No hand in progress';
    else if (nsReason === 'complete') nsTitle = 'All streets revealed';
    else if (nsReason === 'uiLock') nsTitle = 'Please wait…';
    else if (nsReason === 'roundOpen') nsTitle = 'Betting round open';
    else if (nsReason === 'turnMismatch') nsTitle = 'Turn not ready';
    nextStreetBtn.title = nsTitle;

    let label = 'Next Street';
    if (handStatus === 'preflop') label = 'Reveal Flop';
    else if (handStatus === 'flop') label = 'Reveal Turn';
    else if (handStatus === 'turn') label = 'Reveal River';
    else if (handStatus === 'river') label = 'Showdown';
    const t = currentRoom?.hand?.turn;
    if (t && handStatus === t.street && t.roundComplete !== true) {
      label += ' (after actions)';
    }
    nextStreetBtn.textContent = label;
  }

  if (settleBtn) {
    let stReason = null;
    const hand = currentRoom?.hand;
    const bet = hand?.betting;
    const pending = hand?.result?.pending === true;
    if (uiDealLock.active) stReason = 'uiLock';
    else if (state !== 'hand') stReason = 'noHand';
    else if (!isDealer) stReason = 'notDealer';
    else if (!pending) {
      const allInClosed = bet ? Object.entries(bet.in || {}).filter(([p, v]) => v).every(([pid]) => bet.allIn?.[pid]) : false;
      if (hand?.status !== 'river') stReason = 'runStreets';
      else if (!(bet?.roundClosed || allInClosed)) stReason = 'roundOpen';
    }
    settleBtn.disabled = stReason !== null;
    let stTitle = '';
    if (stReason === 'notDealer') stTitle = 'Dealer only';
    else if (stReason === 'noHand') stTitle = 'No hand in progress';
    else if (stReason === 'runStreets') stTitle = 'Run streets first';
    else if (stReason === 'roundOpen') stTitle = 'Betting not closed';
    else if (stReason === 'uiLock') stTitle = 'Please wait…';
    settleBtn.title = stTitle || 'Settle at showdown';
    settleBtn.textContent = pending ? 'Award Pot' : 'Settle Hand';
  }

}

function renderActionControls(room) {
  const uid = auth.currentUser?.uid;
  const turn = room?.hand?.turn;
  const betting = room?.hand?.betting || {};
  const streetMatch = room?.state === 'hand' && turn && room.hand?.status === turn.street;
  const order = turn?.order || [];
  const currentPid = streetMatch ? order[turn.index] || null : null;
  const myTurn = streetMatch && currentPid === uid && turn.roundComplete !== true;
  const committed = betting.committed?.[uid] || 0;
  const toCall = Math.max(0, (betting.currentBet || 0) - committed);
  const myStack = betting.stacks?.[uid] || 0;
  const canAct = betting.in?.[uid] && !betting.allIn?.[uid];
  if (foldBtn) foldBtn.disabled = !(myTurn && canAct);
  if (callBtn) {
    callBtn.disabled = !(myTurn && canAct);
    const label = toCall === 0 ? 'Check' : `Call ${Math.min(toCall, myStack)}`;
    callBtn.textContent = label;
    callBtn.title = myTurn ? '' : 'Not your turn';
  }
  if (raiseBtn) {
    raiseBtn.disabled = !(myTurn && canAct);
    const label = (betting.currentBet || 0) === 0 ? 'Bet' : 'Raise';
    raiseBtn.textContent = label;
  }
  if (betInput) {
    betInput.disabled = !(myTurn && canAct);
    const min = (betting.currentBet || 0) === 0 ? (room.config?.bb || DEFAULT_CONFIG.bb) : (betting.minRaiseTo || 0);
    betInput.min = min;
    betInput.max = committed + myStack;
  }
  if (myConsole) myConsole.classList.toggle('my-turn', myTurn);
  if (turnHint) turnHint.classList.toggle('hidden', !myTurn);
  window.DEBUG?.log('ui.actions.gate.evaluate', {
    myTurn,
    toCall,
    myStack,
    currentBet: betting.currentBet || 0,
    minRaiseTo: betting.minRaiseTo || 0
  });
}

if (prefEl) {
  prefEl.onchange = async (e) => {
    const val = e.target.value === 'OMA' ? 'OMA' : 'HE';
    try {
      const pid = auth.currentUser?.uid;
      if (!pid || !currentRoomRef) return;
      await updateDoc(currentRoomRef, { [`players.${pid}.variantPref`]: val });
      window.DEBUG?.log('variant.pref.set', { pid, value: val });
    } catch (err) {
      window.DEBUG?.log('variant.pref.error', { message: String(err) });
    }
  };
}

if (nextStreetBtn) {
  nextStreetBtn.addEventListener('click', async () => {
    window.DEBUG?.log('street.advance.click', { status: currentRoom?.hand?.status || null });
    if (!currentRoomRef) return;
    try {
      const res = await runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRoomRef);
        if (!snap.exists()) throw { code: 'ROOM_MISSING' };
        const room = snap.data();
        const hand = room.hand || {};

        if (room.state !== 'hand') throw { code: 'NOT_IN_HAND' };

        const myUid = auth.currentUser.uid;
        const mySeat = room.players?.[myUid]?.seat ?? null;
        const dealerSeat = (typeof hand.dealerSeat === 'number') ? hand.dealerSeat : null;
        if (mySeat !== dealerSeat) throw { code: 'NOT_DEALER' };

        const valid = ['preflop', 'flop', 'turn'];
        if (!valid.includes(hand.status)) throw { code: 'ALREADY_COMPLETE_OR_INVALID', status: hand.status };

        const { nextStatus, toAppend, revealCount } = computeBoardNext(room, hand);
        if (!nextStatus || !revealCount) {
          return { type: 'IDEMPOTENT', status: hand.status, boardLen: (hand.board || []).length };
        }

        const newBoard = [ ...(hand.board || []), ...toAppend ];
        const newOrder = computeOrder(room, nextStatus);
        const newTurn = {
          street: nextStatus,
          order: newOrder,
          index: 0,
          roundComplete: false,
          version: (hand.turn?.version || 0) + 1,
          untilPid: newOrder[0] || null
        };
        if (hand.betting) {
          hand.betting.street = nextStatus;
          hand.betting.currentBet = 0;
          hand.betting.lastRaiseSize = room.config?.bb ?? DEFAULT_CONFIG.bb;
          hand.betting.minRaiseTo = room.config?.bb ?? DEFAULT_CONFIG.bb;
          for (const pid in hand.betting.committed) hand.betting.committed[pid] = 0;
          hand.betting.roundClosed = false;
          window.DEBUG?.log('betting.street.reset', { street: nextStatus });
        }
        tx.update(currentRoomRef, {
          hand: {
            ...hand,
            status: nextStatus,
            street: nextStatus,
            board: newBoard,
            lastRevealAt: serverTimestamp(),
            turn: newTurn
          }
        });

        return { type: 'ADVANCED', status: nextStatus, appended: revealCount, boardLen: newBoard.length };
      });

      if (res?.type === 'ADVANCED') {
        window.DEBUG?.log('street.advance.tx.success', res);
      } else {
        window.DEBUG?.log('street.advance.tx.idempotent', res);
      }
    } catch (e) {
      window.DEBUG?.log('street.advance.tx.error', { code: e.code || 'UNKNOWN', detail: e });
    }
  });
}

if (settleBtn) {
  settleBtn.addEventListener('click', async () => {
    const hand = currentRoom?.hand || {};
    const bet = hand.betting || {};
    const path = hand.result?.pending === true ? 'foldAward' : 'showdown';
    window.DEBUG?.log('settle.click', { path });
    if (!currentRoomRef) return;

    const room = currentRoom;
    const payoutMap = {};
    const rankLabels = {};
    let potsResolved = [];

    if (path === 'showdown') {
      const dealt = reconstructHoleCards(room, hand);
      const board = hand.board || [];
      const handRanks = {};
      for (const pid of Object.keys(dealt)) {
        const r = hand.variant === 'OMA' ? evalOmaha(dealt[pid], board) : evalTexas7(dealt[pid], board);
        handRanks[pid] = r;
        rankLabels[pid] = r.label;
        if (hand.variant === 'OMA' && bet.in?.[pid]) {
          window.DEBUG?.log('settle.omaha.rank', { pid, label: r.label });
        }
      }
      const pots = buildSidePots(bet.contrib || {}, bet.in || {});
      window.DEBUG?.log('settle.pots.built', { count: pots.length });
      const seatsArr = room.seats || [];
      pots.forEach((p, idx) => {
        let best = null; let winners = [];
        for (const pid of p.eligibles) {
          const hr = handRanks[pid];
          if (!best || compareHands(hr, best) > 0) {
            best = hr; winners = [pid];
          } else if (compareHands(hr, best) === 0) {
            winners.push(pid);
          }
        }
        let shareBase = winners.length ? Math.floor(p.amount / winners.length) : 0;
        let remainder = winners.length ? p.amount % winners.length : p.amount;
        const shares = winners.map(() => shareBase);
        if (remainder > 0 && winners.length > 0) {
          const order = [];
          for (let i = 1; i <= seatsArr.length; i++) {
            const s = (hand.dealerSeat + i) % seatsArr.length;
            const pid = seatsArr[s];
            if (winners.includes(pid)) order.push(pid);
          }
          const firstRemainderPid = order[0] || null;
          for (let i = 0; i < remainder; i++) {
            const pid = order[i % order.length];
            shares[winners.indexOf(pid)]++;
          }
          window.DEBUG?.log('settle.pot.resolve.remainder', { potIndex: idx, amount: p.amount, winners, base: shareBase, remainder, firstRemainderPid });
        }
        const remainderAfter = p.amount - shares.reduce((a, b) => a + b, 0);
        window.DEBUG?.log('settle.pot.resolve', { potIndex: idx, amount: p.amount, winners, shares, remainder: remainderAfter });
        winners.forEach((pid, i) => { payoutMap[pid] = (payoutMap[pid] || 0) + shares[i]; });
        potsResolved.push({ amount: p.amount, winners: winners.map((pid,i)=>({ pid, share: shares[i] })), eligibles: p.eligibles.length, tie: winners.length > 1 });
      });
    } else {
      const winnerPid = Object.entries(bet.in || {}).find(([pid, v]) => v)?.[0] || null;
      const amount = bet.pot || 0;
      if (winnerPid) {
        payoutMap[winnerPid] = amount;
        potsResolved = [{ amount, winners: [{ pid: winnerPid, share: amount }], eligibles: 1, tie: false }];
      }
    }

    try {
      const res = await runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRoomRef);
        if (!snap.exists()) throw { code: 'ROOM_MISSING' };
        const roomTx = snap.data();
        const h = roomTx.hand || {};
        if (roomTx.state !== 'hand' || !h.id || h.id !== hand.id || h.status === 'paid') {
          return { type: 'IDEMPOTENT', handId: hand.id };
        }
        if (path === 'showdown') {
          const b = h.betting || {};
          const allInClosed = Object.entries(b.in || {}).filter(([p, v]) => v).every(([pid]) => b.allIn?.[pid]);
          if (h.status !== 'river' || (!(b.roundClosed || allInClosed)) || (h.variant !== 'HE' && h.variant !== 'OMA')) {
            throw { code: 'PRECONDITION_FAILED' };
          }
        }

        const playerUpdates = {};
        for (const pid in bet.stacks) {
          const finalStack = (bet.stacks[pid] || 0) + (payoutMap[pid] || 0);
          playerUpdates[`players.${pid}.stack`] = finalStack;
        }

        const result = {
          handId: h.id,
          pots: potsResolved,
          payout: payoutMap,
          rankLabels,
          reason: path === 'showdown' ? 'showdown' : (h.result?.reason || 'showdown'),
          paidAt: serverTimestamp()
        };

        const nextDealerSeat = nextOccupiedLeftOf(h.dealerSeat, roomTx.seats || []);
        tx.update(currentRoomRef, {
          state: 'idle',
          lastResult: {
            id: h.id,
            board: h.board || [],
            variant: h.variant,
            dealerSeat: h.dealerSeat,
            result
          },
          dealerSeat: nextDealerSeat,
          nextVariant: null,
          hand: null,
          ...playerUpdates
        });

        return { type: 'SETTLED', handId: h.id, pots: potsResolved.length, winners: Object.keys(payoutMap).length, path, nextDealerSeat };
      });
      if (res?.type === 'SETTLED') {
        window.DEBUG?.log('settle.tx.success', { handId: res.handId, variant: hand.variant, pots: res.pots, winners: res.winners });
        window.DEBUG?.log('dealer.rotate', { dealerSeat: res.nextDealerSeat });
        window.DEBUG?.log('variant.lock.cleared', {});
        if (path === 'foldAward') {
          const pid = Object.keys(payoutMap)[0];
          const amount = payoutMap[pid];
          window.DEBUG?.log('settle.fold.award', { pid, amount });
        }
      } else {
        window.DEBUG?.log('settle.tx.idempotent', { handId: hand.id });
      }
    } catch (e) {
      window.DEBUG?.log('settle.tx.error', { code: e.code || 'UNKNOWN', detail: e });
    }
  });
}

function nextActiveIndex(order, startIdx, bet) {
  const len = order.length;
  for (let i = 1; i <= len; i++) {
    const idx = (startIdx + i) % len;
    const pid = order[idx];
    if (bet.in?.[pid]) return idx;
  }
  return startIdx;
}

function isRoundClosed(bet) {
  const currentBet = bet.currentBet || 0;
  const participants = Object.keys(bet.in || {});
  const active = participants.filter(pid => bet.in[pid] && !bet.allIn?.[pid]);
  if (active.length <= 1) return true;
  return participants.every(pid => !bet.in[pid] || bet.allIn?.[pid] || ((bet.committed?.[pid] || 0) === currentBet));
}

if (foldBtn) {
  foldBtn.addEventListener('click', async () => {
    const uid = auth.currentUser?.uid;
    try {
      const txRes = await runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRoomRef);
        if (!snap.exists()) throw { code: 'ROOM_MISSING' };
        const room = snap.data();
        if (room.state !== 'hand') throw { code: 'NOT_IN_HAND' };
        const hand = room.hand || {};
        const turn = hand.turn || {};
        const bet = hand.betting || {};
        const pid = turn.order?.[turn.index] || null;
        if (hand.status !== turn.street || pid !== uid) throw { code: 'TURN_MISMATCH' };
        if (!bet.in?.[uid] || bet.allIn?.[uid]) throw { code: 'CANNOT_ACT' };
        bet.in[uid] = false;
        let remaining = 0; for (const p in bet.in) if (bet.in[p]) remaining++;
        if (remaining <= 1) {
          hand.turn.roundComplete = true;
          bet.roundClosed = true;
          hand.result = { pending: true, reason: 'everyoneFolded' };
        }
        const nextIdx = nextActiveIndex(turn.order || [], turn.index, bet);
        turn.index = nextIdx;
        tx.update(currentRoomRef, { hand });
      });
      const actionsRef = collection(db, 'rooms', roomCode, 'hands', currentRoom.hand.id, 'actions');
      await addDoc(actionsRef, { pid: uid, street: currentRoom.hand.status, type: 'fold', ts: serverTimestamp() });
      window.DEBUG?.log('action.fold.success', { pid: uid });
    } catch (e) {
      window.DEBUG?.log('action.fold.error', { code: e.code || 'UNKNOWN' });
    }
    renderActionControls(currentRoom);
  });
}

  if (callBtn) {
    callBtn.addEventListener('click', async () => {
    const uid = auth.currentUser?.uid;
    try {
      const txRes = await runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRoomRef);
        if (!snap.exists()) throw { code: 'ROOM_MISSING' };
        const room = snap.data();
        if (room.state !== 'hand') throw { code: 'NOT_IN_HAND' };
        const hand = room.hand || {};
        const turn = hand.turn || {};
        const bet = hand.betting || {};
        const order = turn.order || [];
        const pid = order[turn.index] || null;
        if (hand.status !== turn.street || pid !== uid) throw { code: 'TURN_MISMATCH' };
        if (!bet.in?.[uid] || bet.allIn?.[uid]) throw { code: 'CANNOT_ACT' };
        const committed = bet.committed?.[uid] || 0;
        const toCall = Math.max(0, (bet.currentBet || 0) - committed);
        const stack = bet.stacks?.[uid] || 0;
        if (toCall > 0) {
          const pay = Math.min(toCall, stack);
          bet.committed[uid] = committed + pay;
          bet.stacks[uid] = stack - pay;
          bet.pot += pay;
          bet.contrib = bet.contrib || {};
          bet.contrib[uid] = (bet.contrib[uid] || 0) + pay;
          if (bet.stacks[uid] === 0) bet.allIn[uid] = true;
          window.DEBUG?.log('betting.contrib.update', { pid: uid, add: pay, total: bet.contrib[uid] });
          window.DEBUG?.log('action.call.success', { pid: uid, amount: pay, pot: bet.pot });
          const nextIdx = nextActiveIndex(order, turn.index, bet);
          turn.index = nextIdx;
          if (order[nextIdx] === hand.turn.untilPid && isRoundClosed(bet)) {
            hand.turn.roundComplete = true;
            bet.roundClosed = true;
            window.DEBUG?.log('betting.round.closed', { street: bet.street });
          }
          tx.update(currentRoomRef, { hand });
          return { type: 'call', amount: pay };
        } else {
          const nextIdx = nextActiveIndex(order, turn.index, bet);
          turn.index = nextIdx;
          if (order[nextIdx] === hand.turn.untilPid && isRoundClosed(bet)) {
            hand.turn.roundComplete = true;
            bet.roundClosed = true;
            window.DEBUG?.log('betting.round.closed', { street: bet.street });
          }
          tx.update(currentRoomRef, { hand });
          window.DEBUG?.log('action.check.success', { pid: uid });
          return { type: 'check', amount: 0 };
        }
      });
      const actionsRef = collection(db, 'rooms', roomCode, 'hands', currentRoom.hand.id, 'actions');
      await addDoc(actionsRef, { pid: uid, street: currentRoom.hand.status, type: txRes.type, amount: txRes.amount, ts: serverTimestamp() });
    } catch (e) {
      window.DEBUG?.log('action.check.error', { code: e.code || 'UNKNOWN' });
    }
    renderActionControls(currentRoom);
  });
}

  if (raiseBtn) {
    raiseBtn.addEventListener('click', async () => {
    const uid = auth.currentUser?.uid;
    const desired = parseInt(betInput?.value || '0', 10);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRoomRef);
        if (!snap.exists()) throw { code: 'ROOM_MISSING' };
        const room = snap.data();
        if (room.state !== 'hand') throw { code: 'NOT_IN_HAND' };
        const hand = room.hand || {};
        const turn = hand.turn || {};
        const bet = hand.betting || {};
        const order = turn.order || [];
        const pid = order[turn.index] || null;
        if (hand.status !== turn.street || pid !== uid) throw { code: 'TURN_MISMATCH' };
        if (!bet.in?.[uid] || bet.allIn?.[uid]) throw { code: 'CANNOT_ACT' };
        const committed = bet.committed?.[uid] || 0;
        const stack = bet.stacks?.[uid] || 0;
        const minTo = (bet.currentBet || 0) === 0 ? (room.config?.bb || DEFAULT_CONFIG.bb) : bet.minRaiseTo;
        const maxTo = committed + stack;
        let desiredTo = Math.max(minTo, Math.min(desired, maxTo));
        const delta = desiredTo - committed;
        if (delta <= 0) throw { code: 'INVALID_BET' };
        bet.committed[uid] = desiredTo;
        bet.stacks[uid] = stack - delta;
        bet.pot += delta;
        bet.contrib = bet.contrib || {};
        bet.contrib[uid] = (bet.contrib[uid] || 0) + delta;
        window.DEBUG?.log('betting.contrib.update', { pid: uid, add: delta, total: bet.contrib[uid] });
        if (bet.stacks[uid] === 0) bet.allIn[uid] = true;
        const prevBet = bet.currentBet || 0;
        bet.currentBet = Math.max(prevBet, desiredTo);
        const effectiveRaise = bet.currentBet - prevBet;
        if (effectiveRaise >= (bet.lastRaiseSize || 0)) {
          bet.lastRaiseSize = effectiveRaise;
          bet.minRaiseTo = bet.currentBet + bet.lastRaiseSize;
        }
        bet.lastAggressorPid = uid;
        hand.turn.untilPid = uid;
        const nextIdx = nextActiveIndex(order, turn.index, bet);
        turn.index = nextIdx;
        tx.update(currentRoomRef, { hand });
        const type = prevBet === 0 ? 'bet' : 'raise';
        window.DEBUG?.log(`action.${type}.success`, { pid: uid, to: desiredTo, delta, pot: bet.pot });
        return { to: desiredTo, delta, type };
      });
      const actionsRef = collection(db, 'rooms', roomCode, 'hands', currentRoom.hand.id, 'actions');
      await addDoc(actionsRef, { pid: uid, street: currentRoom.hand.status, type: txRes.type, to: txRes.to, delta: txRes.delta, ts: serverTimestamp() });
    } catch (e) {
      window.DEBUG?.log('action.bet.error', { code: e.code || 'UNKNOWN' });
    }
    renderActionControls(currentRoom);
  });
}

function normalizeRoomCode(raw) {
  const s = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.slice(0, 8);
}

function genRoomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const joinOverlay = document.getElementById('join-overlay');
const openJoinBtn = document.getElementById('open-join');
const displayNameInput = document.getElementById('displayName');
const roomCodeInput = document.getElementById('roomCode');
const joinError = document.getElementById('join-error');

function openJoin() {
  if (!joinOverlay) return;
  joinOverlay.classList.remove('hidden');
  if (joinError) joinError.textContent = '';
  displayNameInput?.classList.remove('invalid');
  roomCodeInput?.classList.remove('invalid');
  if (displayNameInput) setTimeout(() => displayNameInput.focus(), 0);
  debug.log('ui.join.open', {});
}

function closeJoin() {
  joinOverlay?.classList.add('hidden');
}

if (openJoinBtn) {
  openJoinBtn.addEventListener('click', openJoin);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeJoin();
  }
});

const createBtn = document.getElementById('create-room');
if (createBtn) createBtn.addEventListener('click', () => submitJoin('create'));
const joinBtn = document.getElementById('join-room');
if (joinBtn) joinBtn.addEventListener('click', () => submitJoin('join'));

function startHeartbeat(roomRef, uid) {
  const tick = () => {
    updateDoc(roomRef, {
      [`players.${uid}.lastSeen`]: serverTimestamp(),
      [`players.${uid}.active`]: true
    });
    window.DEBUG?.log('presence.heartbeat.tick', { interval: PRESENCE.HEARTBEAT_MS });
  };
  tick();
  window.DEBUG?.log('presence.heartbeat.prime', {});
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(tick, PRESENCE.HEARTBEAT_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tick();
      window.DEBUG?.log('presence.heartbeat.wakeup', { visibility: 'visible' });
    }
  });

  const unload = () => {
    updateDoc(roomRef, {
      [`players.${uid}.active`]: false,
      [`players.${uid}.lastSeen`]: serverTimestamp()
    }).catch(() => {});
    window.DEBUG?.log('presence.unload.bestEffort', {});
  };
  window.addEventListener('pagehide', unload);
  window.addEventListener('beforeunload', unload);
}

async function attemptEvict(roomRef, uid) {
  try {
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      const data = snap.data();
      const now = Date.now();
      const lock = data.evictionLock;
      if (lock?.at && (now - lock.at.toMillis()) < PRESENCE.LOCK_TTL_MS) {
        return { skip: { lockBy: lock.by, ageMs: now - lock.at.toMillis() } };
      }

      const players = data.players || {};
      const seats = data.seats || [];
      const freed = [];
      for (const [pid, p] of Object.entries(players)) {
        const lastSeen = p.lastSeen?.toMillis ? p.lastSeen.toMillis() : null;
        const isStale = p.active !== true || (lastSeen && (now - lastSeen > PRESENCE.STALE_AFTER_MS));
        if (isStale) {
          if (p.seat != null && seats[p.seat] === pid) {
            seats[p.seat] = null;
            freed.push({ pid, seat: p.seat });
            p.seat = null;
          }
          p.active = false;
        }
      }
      const evictionLock = { by: uid, at: serverTimestamp() };
      tx.update(roomRef, { players, seats, evictionLock });
      return { freed };
    });

    if (result.skip) {
      window.DEBUG?.log('presence.evict.skip', { reason: 'lockHeld', lockBy: result.skip.lockBy, ageMs: result.skip.ageMs });
    } else if (result.freed.length > 0) {
      window.DEBUG?.log('presence.evict.success', { freed: result.freed, totalFreed: result.freed.length });
    } else {
      window.DEBUG?.log('presence.evict.noop', { reason: 'noneStale' });
    }
  } catch (e) {
    // ignore errors
  }
}

async function handleSeatClick(seatIdx){
  const uid = auth.currentUser?.uid;
  if(!uid || !currentRoomRef) return;
  try{
    await runTransaction(db, async tx => {
      const roomSnap = await tx.get(currentRoomRef);
      const room = roomSnap.data();
      const cfg = room.config || {};
      const min = cfg.minBuyIn || 10;
      const seats = room.seats || [];
      const players = room.players || {};
      const stackMap = room.stacks || {};
      const wRef = doc(db,'wallets',uid);
      const wSnap = await tx.get(wRef);
      const bal = wSnap.data()?.balance || 0;
      if(seats[seatIdx] && seats[seatIdx] !== uid) throw {code:'SEAT_TAKEN'};
      if(seats[seatIdx] === uid){
        if(room.state === 'hand') throw {code:'IN_HAND'};
        const stack = stackMap[uid] || 0;
        tx.update(wRef,{ balance: bal + stack, updatedAt:serverTimestamp() });
        seats[seatIdx] = null;
        players[uid].seat = null;
        delete stackMap[uid];
        tx.update(currentRoomRef,{ seats, players, stacks: stackMap });
        debug.log('seat.leave.success',{ seat: seatIdx });
      }else{
        if(bal < min) throw {code:'INSUFFICIENT'};
        tx.update(wRef,{ balance: bal - min, updatedAt:serverTimestamp() });
        seats[seatIdx] = uid;
        players[uid] = players[uid] || { displayName:null, seat:null, lastSeen:serverTimestamp(), variantPref:null };
        players[uid].seat = seatIdx;
        stackMap[uid] = (stackMap[uid] || 0) + min;
        tx.update(currentRoomRef,{ seats, players, stacks: stackMap });
        debug.log('seat.claim.success',{ seat: seatIdx });
        debug.log('buyin.success',{ amount: min });
      }
    });
  }catch(e){
    debug.log('seat.click.error',{ code: e.code || 'UNKNOWN' });
  }
}

function evaluateAndRenderGate() {
  if (!currentRoom) return;
  const uid = auth.currentUser?.uid;
  const gate = computeDealGate(currentRoom, uid, uiDealLock.active);
  derivedDealerSeat = gate.derivedDealerSeat;
  upcomingDealerPid = gate.upcomingDealerPid;
  activeSeated = gate.activeSeated;
  totalSeated = gate.totalSeated;
  const firstReason = gate.reasons[0] || null;
  debug.log('gate.active.count', { activeSeated: gate.activeSeated, totalSeated: gate.totalSeated });
  debug.log('ui.gate.evaluate', { ...gate, firstReason });
  renderGatedControls(gate, firstReason);
  const mySeat = currentRoom?.players?.[uid]?.seat ?? null;
  debug.updateGateInspector({
    state: gate.state,
    handStatus: gate.handStatus,
    variant: gate.lockedVariant,
    activeSeated: gate.activeSeated,
    totalSeated: gate.totalSeated,
    derivedDealerSeat: gate.derivedDealerSeat,
    mySeat,
    isDealer: gate.isDealer,
    uiLock: uiDealLock.active,
    firstReason,
    reasons: gate.reasons
  });
  maybeLockNextVariant(currentRoom, gate);
  maybeAutoDeal(currentRoom, gate);
}

function startEvictionSweeper(roomRef, uid) {
  clearInterval(sweeperTimer);
  sweeperTimer = setInterval(() => {
    attemptEvict(roomRef, uid);
  }, PRESENCE.SWEEP_INTERVAL_MS);
}

let roomUnsub = null;

async function joinRoomByCode(code){
  const uid = auth.currentUser?.uid;
  if(!uid) return;
  const roomRef = doc(db,'rooms',code);
  const seat = await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if(!snap.exists()) throw { code:'ROOM_MISSING' };
    const data = snap.data() || {};
    const pathBase = `players.${uid}`;
    const player = data.players?.[uid] || {};
    if (!data.players || !data.players[uid]) {
      tx.update(roomRef, {
        [`${pathBase}.seat`]: null,
        [`${pathBase}.lastSeen`]: serverTimestamp(),
        [`${pathBase}.joinedAt`]: serverTimestamp(),
        [`${pathBase}.active`]: true
      });
    } else {
      tx.update(roomRef, {
        [`${pathBase}.lastSeen`]: serverTimestamp(),
        [`${pathBase}.active`]: true
      });
    }
    return player.seat ?? null;
  });

  roomCode = code;
  window.APP = window.APP || {};
  window.APP.roomCode = code;
  const myName = await ensureRoomDisplayName(db, roomRef, uid);
  document.documentElement.setAttribute('data-me-name', myName);
  sessionStorage.setItem('playerName', myName);
  renderMyConsole(myName);
  debug.log('nav.table.enter', { roomCode: code });
  document.getElementById('room-code').textContent = code;
  currentRoomRef = roomRef;
  startHeartbeat(currentRoomRef, uid);
  startEvictionSweeper(currentRoomRef, uid);
  clearInterval(dealLockSweeperTimer);
  dealLockSweeperTimer = setInterval(() => sweepExpiredDealLock(db, currentRoomRef), DEAL_LOCK.SWEEP_INTERVAL_MS);
  if (roomUnsub) roomUnsub();
  roomUnsub = onSnapshot(currentRoomRef, (snap) => {
    const data = snap.data();
    renderRoom(data);
    const playersCount = data.players ? Object.keys(data.players).length : 0;
    const seatedCount = data.seats ? data.seats.filter(Boolean).length : 0;
    debug.log('room.snapshot', { players: playersCount, seated: seatedCount });
  });
  debug.log('room.join.success', { code, seat, displayName: myName });
}

async function submitJoin(mode) {
  const displayName = displayNameInput.value.trim();
  let code = normalizeRoomCode(roomCodeInput.value);

  displayNameInput.classList.remove('invalid');
  roomCodeInput.classList.remove('invalid');

  if (displayName.length < 2 || displayName.length > 20) {
    joinError.textContent = 'Name must be 2–20 characters.';
    displayNameInput.classList.add('invalid');
    debug.log('room.join.error', { code, reason: 'VALIDATION' });
    return;
  }

  if (mode === 'create' && !code) {
    code = genRoomCode();
  }

  if (!code || code.length < 4) {
    joinError.textContent = 'Room code must be 4–8 characters.';
    roomCodeInput.classList.add('invalid');
    debug.log('room.join.error', { code, reason: 'VALIDATION' });
    return;
  }

  joinError.textContent = '';
  debug.log('ui.join.submit', { mode, code, displayName });

  const uid = auth.currentUser?.uid;
  try {
    let created = false;
    const seat = await runTransaction(db, async (tx) => {
      const roomRef = doc(db, 'rooms', code);
      const snap = await tx.get(roomRef);
      let data;
      if (!snap.exists()) {
        data = {
          code,
          active: true,
          createdAt: serverTimestamp(),
          state: 'idle',
          dealerSeat: null,
          seats: [null, null, null, null, null, null, null, null, null],
          nextVariant: null,
          players: {}
        };
        tx.set(roomRef, data);
        created = true;
      } else {
        data = snap.data();
      }

      data.players = data.players || {};
      data.seats = data.seats || [null, null, null, null, null, null, null, null, null];

      let player = data.players[uid];
      if (!player) {
        player = {
          displayName,
          active: true,
          seat: null,
          joinedAt: serverTimestamp(),
          lastSeen: serverTimestamp(),
          variantPref: null
        };
      } else {
        player.displayName = displayName;
        player.active = true;
        player.lastSeen = serverTimestamp();
      }

      if (player.seat == null) {
        const seatIndex = data.seats.findIndex((s) => s == null);
        if (seatIndex === -1) {
          throw new Error('ROOM_FULL');
        }
        player.seat = seatIndex;
        data.seats[seatIndex] = uid;
      } else {
        const seatIndex = player.seat;
        if (data.seats[seatIndex] !== uid) {
          data.seats[seatIndex] = uid;
        }
      }

      data.players[uid] = player;
      tx.set(roomRef, { code, players: data.players, seats: data.seats }, { merge: true });
      return player.seat;
    });

    roomCode = code;
    window.APP = window.APP || {};
    window.APP.roomCode = code;
    document.getElementById('room-code').textContent = code;
    debug.log('room.join.success', { code, seat });
    if (created) {
      debug.log('room.create.success', { code });
    }
    closeJoin();

    const roomRef = doc(db, 'rooms', code);
    currentRoomRef = roomRef;
    await updateDoc(roomRef, {
      [`players.${uid}.lastSeen`]: serverTimestamp(),
      [`players.${uid}.active`]: true
    });

    startHeartbeat(roomRef, uid);
    startEvictionSweeper(roomRef, uid);
    clearInterval(dealLockSweeperTimer);
    dealLockSweeperTimer = setInterval(() => sweepExpiredDealLock(db, roomRef), DEAL_LOCK.SWEEP_INTERVAL_MS);

    if (roomUnsub) roomUnsub();
    roomUnsub = onSnapshot(roomRef, (snap) => {
      const data = snap.data();
      renderRoom(data);
      const playersCount = data.players ? Object.keys(data.players).length : 0;
      const seatedCount = data.seats ? data.seats.filter(Boolean).length : 0;
      debug.log('room.snapshot', { players: playersCount, seated: seatedCount });
    });
  } catch (err) {
    if (err.message === 'ROOM_FULL') {
      joinError.textContent = 'Room is full.';
      debug.log('room.join.error', { code, reason: 'ROOM_FULL' });
    } else {
      joinError.textContent = 'Failed to join room.';
      debug.log('room.join.error', { code, reason: 'UNKNOWN' });
    }
  }
}

async function maybeInitTurn(room) {
  const uid = auth.currentUser?.uid;
  const hand = room?.hand || {};
  if (room?.state !== 'hand') return;
  if (!hand.status) return;
  const mySeat = room.players?.[uid]?.seat ?? null;
  const dealerSeat = hand.dealerSeat;
  if (mySeat == null || dealerSeat == null || mySeat !== dealerSeat) return;
  if (hand.turn && hand.turn.street === hand.status) return;
  const order = computeOrder(room, hand.status);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(currentRoomRef);
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.state !== 'hand') return;
      const h = data.hand || {};
      const seat = data.players?.[uid]?.seat ?? null;
      if (seat !== h.dealerSeat) return;
      if (h.turn && h.turn.street === h.status) return;
      const turn = {
        street: h.status,
        order,
        index: 0,
        roundComplete: false,
        version: (h.turn?.version || 0) + 1
      };
      tx.update(currentRoomRef, { 'hand.turn': turn });
    });
    window.DEBUG?.log('turn.init', { street: hand.status, orderLen: order.length });
  } catch (e) {
    // ignore
  }
}

async function maybeInitBetting(room) {
  const hand = room?.hand || {};
  if (room?.state !== 'hand') return;
  if (hand.status !== 'preflop' || hand.variant !== 'HE') return;
  if (hand.betting?.initialized) return;
  try {
    const res = await runTransaction(db, async (tx) => {
      const snap = await tx.get(currentRoomRef);
      if (!snap.exists()) throw { code: 'ROOM_MISSING' };
      const rm = snap.data();
      if (rm.state !== 'hand') throw { code: 'NOT_IN_HAND' };
      const h = rm.hand || {};
      if (h.status !== 'preflop' || h.variant !== 'HE') return { type: 'NOP' };
      if (h.betting?.initialized) return { type: 'IDEMPOTENT' };
      const seats = rm.seats || [];
      const participants = h.participants || [];
      const occupied = (idx) => {
        const pid = seats[idx];
        return pid && participants.includes(pid);
      };
      const nextOccupied = (start) => {
        for (let k = 1; k <= 9; k++) {
          const s = (start + k) % 9;
          if (occupied(s)) return s;
        }
        return null;
      };
      const dealerSeat = h.dealerSeat;
      const sbSeat = nextOccupied(dealerSeat);
      const bbSeat = nextOccupied(sbSeat ?? dealerSeat);
      const sbPid = seats[sbSeat];
      const bbPid = seats[bbSeat];
      const stacks = {}; const committed = {}; const inMap = {}; const allIn = {}; const contrib = {};
      for (const pid of participants) {
        stacks[pid] = rm.players?.[pid]?.stack ?? rm.config?.startingStack ?? DEFAULT_CONFIG.startingStack;
        committed[pid] = 0;
        inMap[pid] = true;
        allIn[pid] = false;
        contrib[pid] = 0;
      }
      const sb = rm.config?.sb ?? DEFAULT_CONFIG.sb;
      const bb = rm.config?.bb ?? DEFAULT_CONFIG.bb;
      committed[sbPid] += sb; stacks[sbPid] -= sb; contrib[sbPid] += sb;
      committed[bbPid] += bb; stacks[bbPid] -= bb; contrib[bbPid] += bb;
      window.DEBUG?.log('betting.contrib.update', { pid: sbPid, add: sb, total: contrib[sbPid] });
      window.DEBUG?.log('betting.contrib.update', { pid: bbPid, add: bb, total: contrib[bbPid] });
      if (stacks[sbPid] < 0) { committed[sbPid] += stacks[sbPid]; stacks[sbPid] = 0; allIn[sbPid] = true; }
      if (stacks[bbPid] < 0) { committed[bbPid] += stacks[bbPid]; stacks[bbPid] = 0; allIn[bbPid] = true; }
      const pot = committed[sbPid] + committed[bbPid];
      const bet = {
        initialized: true,
        street: 'preflop',
        pot,
        currentBet: bb,
        lastRaiseSize: bb,
        minRaiseTo: bb * 2,
        committed,
        stacks,
        in: inMap,
        allIn,
        contrib,
        sb, bb,
        sbPid, bbPid,
        lastAggressorPid: bbPid,
        roundClosed: false
      };
      h.betting = bet;
      h.turn = h.turn || {};
      h.turn.untilPid = bbPid;
      tx.update(currentRoomRef, { hand: h });
      return { type: 'INIT', sb, bb, pot, sbPid, bbPid };
    });
    if (res?.type === 'INIT') {
      window.DEBUG?.log('betting.init.success', res);
    } else if (res?.type === 'IDEMPOTENT') {
      window.DEBUG?.log('betting.init.idempotent', {});
    }
  } catch (e) {
    window.DEBUG?.log('betting.init.error', { code: e.code || 'UNKNOWN' });
  }
}

function renderRoom(data) {
  currentRoom = data;
  ensureRoomConfig(currentRoom);
  ensureMyHandListener(data);
  maybeInitTurn(data);
  maybeInitBetting(data);
  maybeAutoReleaseUiDealLock(data);
  evaluateAndRenderGate();

  if (lockInfoEl) {
    if (data.state === 'dealLocked' && data.hand?.status === 'locked') {
      const id = data.hand.id || '';
      lockInfoEl.textContent = `Lock: ${id.slice(-4)}…`;
    } else {
      lockInfoEl.textContent = '';
    }
  }

  const uid = auth.currentUser?.uid;
  const mySeat = data.players?.[uid]?.seat ?? null;
  const serverSeatForUi = (uiIndex) => {
    if (mySeat == null) return uiIndex;
    return (mySeat + uiIndex) % 9;
  };

  const turn = data.hand?.turn;
  const turnStreetMatch = data.state === 'hand' && turn && data.hand?.status === turn.street;
  const currentPid = turnStreetMatch ? (turn.order || [])[turn.index] || null : null;
  const orderLen = turnStreetMatch ? (turn.order || []).length : 0;
  const turnIndex = turnStreetMatch ? turn.index : -1;

  if (mySeat == null) {
    debug.log('ui.seats.rotate.skip', { reason: 'notSeated' });
  } else {
    debug.log('ui.seats.rotate.apply', { mySeat });
  }

  for (let uiIndex = 0; uiIndex < 9; uiIndex++) {
    const seatEl = document.querySelector(`.seat-${uiIndex}`);
    if (!seatEl) continue;
    const nameEl = seatEl.querySelector('.name');
    const stackEl = seatEl.querySelector('.stack');
    const statusDot = seatEl.querySelector('.status-dot');
    const badgesEl = seatEl.querySelector('.badges');
    const sIdx = serverSeatForUi(uiIndex);
    const pid = data.seats ? data.seats[sIdx] : null;
    if (pid) {
      const player = data.players?.[pid] || {};
      nameEl.textContent = pid === uid ? `${player.displayName || 'Player'} (you)` : (player.displayName || 'Player');
      if (statusDot) statusDot.className = `status-dot ${player.active ? 'active' : ''}`;
      const bet = data.hand?.betting || {};
      const stack = bet.stacks?.[pid] ?? data.stacks?.[pid];
      if (stack != null) stackEl.textContent = `$${stack}`; else stackEl.textContent = '$—';
      seatEl.classList.toggle('me', pid === uid);
      seatEl.classList.toggle('folded', bet.in && bet.in[pid] === false);
      let allInEl = badgesEl.querySelector('.all-in-badge');
      if (bet.allIn && bet.allIn[pid]) {
        if (!allInEl) {
          allInEl = document.createElement('span');
          allInEl.className = 'all-in-badge';
          allInEl.textContent = 'All-in';
          badgesEl.appendChild(allInEl);
        }
        allInEl.style.display = 'inline-block';
      } else if (allInEl) {
        allInEl.remove();
      }
    } else {
      nameEl.textContent = `Seat ${sIdx + 1}`;
      if (statusDot) statusDot.className = 'status-dot';
      stackEl.textContent = '$—';
      seatEl.classList.remove('me');
      seatEl.classList.remove('folded');
      const allInEl = badgesEl.querySelector('.all-in-badge');
      if (allInEl) allInEl.remove();
    }
    seatEl.classList.toggle('turn', pid && pid === currentPid);

    let dealerEl = badgesEl.querySelector('.dealer-btn');
    let sbEl = badgesEl.querySelector('.sb-btn');
    let bbEl = badgesEl.querySelector('.bb-btn');
    const dealerSeat = data.state === 'hand' ? data.hand?.dealerSeat : derivedDealerSeat;
    if (dealerSeat != null && sIdx === dealerSeat) {
      if (!dealerEl) {
        dealerEl = document.createElement('span');
        dealerEl.className = 'dealer-btn';
        dealerEl.textContent = 'D';
        badgesEl.appendChild(dealerEl);
      }
    } else if (dealerEl) {
      dealerEl.remove();
    }
    if (data.state === 'hand' && pid) {
      if (pid === data.hand?.sbPid) {
        if (!sbEl) {
          sbEl = document.createElement('span');
          sbEl.className = 'sb-btn';
          sbEl.textContent = 'SB';
          badgesEl.appendChild(sbEl);
        }
      } else if (sbEl) {
        sbEl.remove();
      }
      if (pid === data.hand?.bbPid) {
        if (!bbEl) {
          bbEl = document.createElement('span');
          bbEl.className = 'bb-btn';
          bbEl.textContent = 'BB';
          badgesEl.appendChild(bbEl);
        }
      } else if (bbEl) {
        bbEl.remove();
      }
    } else {
      if (sbEl) sbEl.remove();
      if (bbEl) bbEl.remove();
    }

    const existingHole = seatEl.querySelector('.cards');
    const holeCount = data.hand?.holeCount || 0;
    if (pid && pid !== uid && data.state === 'hand' && (data.hand.participants || []).includes(pid) && data.hand.status === 'preflop') {
      renderOpponentHoles(holeCount, seatEl);
    } else if (existingHole) {
      existingHole.remove();
    }
  }
  renderMyCards(myHandCards, data.hand?.holeCount || 0);
  window.DEBUG?.log('ui.cards.render', { my: myHandCards?.length || 0, others: 'back' });

  if (turnStreetMatch) {
    window.DEBUG?.log('turn.render.current', { street: turn.street, currentPid, index: turnIndex, orderLen });
  }

  const board = data.hand?.board || [];
  renderBoard(board);
  window.DEBUG?.log('ui.board.render', { count: board.length, status: data.hand?.status || null });

  let banner = document.getElementById('result-banner');
  if (data.state === 'idle' && data.lastResult?.id) {
    const res = data.lastResult.result || {};
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'result-banner';
      banner.className = 'result-banner';
      boardEl?.parentElement?.appendChild(banner);
    }
    const payout = res.payout || {};
    const winnersText = Object.entries(payout).filter(([pid, amt]) => amt > 0).map(([pid, amt]) => {
      const name = data.players?.[pid]?.displayName || 'Player';
      return `${name} (+$${amt})`;
    }).join(', ');
    const variantName = data.lastResult.variant === 'OMA' ? 'Omaha' : 'Texas';
    let html = `<span class="variant-tag">${variantName}</span> Winners: ${winnersText}`;
    const pots = res.pots || [];
    if (pots.length > 1) {
      pots.forEach((p, idx) => {
        if (idx === 0) return;
        const line = p.winners.map(w => {
          const name = data.players?.[w.pid]?.displayName || 'Player';
          return `${name} +$${w.share}`;
        }).join(', ');
        html += `<div class="side-pot">Side Pot #${idx + 1}: ${line}${p.tie ? ' (tie)' : ''}</div>`;
      });
    }
    banner.innerHTML = html;
    window.DEBUG?.log('ui.result.render', { handId: data.lastResult.id, variant: data.lastResult.variant, pots: pots.length });
  } else if (banner) {
    banner.remove();
  }

  if (data.state === 'hand' && data.hand?.status === 'preflop') {
    window.DEBUG?.log('ui.hole.render.others', { holeCount: data.hand.holeCount || 0 });
  }

  renderActionControls(data);
  maybeRunDeal(data);
}

function renderMyCards(indices = [], holeCount = 0) {
  const wrap = document.getElementById('my-cards');
  if (!wrap) return;
  wrap.innerHTML = '';
  (indices || []).slice(0, holeCount).forEach(i => wrap.appendChild(cardImgByIndex(i)));
}

function renderOpponentHoles(holeCount, seatEl) {
  const wrap = seatEl.querySelector('.cards') || (() => {
    const w = document.createElement('div');
    w.className = 'cards';
    w.style.display = 'flex';
    w.style.gap = '4px';
    seatEl.appendChild(w);
    return w;
  })();
  wrap.innerHTML = '';
  for (let k = 0; k < holeCount; k++) {
    const img = new Image();
    img.src = CARD_BACK;
    img.alt = 'back';
    wrap.appendChild(img);
  }
}

function renderBoard(boardIndices = []) {
  const board = document.getElementById('board');
  if (!board) return;
  board.innerHTML = '';
  (boardIndices || []).forEach(i => board.appendChild(cardImgByIndex(i)));
}

function ensureMyHandListener(room) {
  const uid = auth.currentUser?.uid;
  const handId = room?.hand?.id;
  if (!uid || !roomCode || !handId) {
    if (myHandUnsub) myHandUnsub();
    myHandUnsub = null;
    myHandId = null;
    myHandCards = null;
    renderMyCards([], 0);
    return;
  }
  if (myHandId === handId) return;
  if (myHandUnsub) myHandUnsub();
  myHandId = handId;
  const handRef = doc(db, 'rooms', roomCode, 'players', uid, 'hands', handId);
  myHandUnsub = onSnapshot(handRef, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      myHandCards = data.cards || [];
      renderMyCards(myHandCards, room.hand?.holeCount || 0);
      window.DEBUG?.log('hand.private.listen.ready', { handId });
      window.DEBUG?.log('ui.hole.render.mine', { cards: myHandCards });
      renderRoom(currentRoom);
    }
  });
}

async function ensureRoomConfig(room) {
  if (!room) return;
  if (room.config) return;
  try {
    if (currentRoomRef) {
      await updateDoc(currentRoomRef, { config: DEFAULT_CONFIG });
    }
  } catch (e) {
    // ignore
  }
  room.config = { ...DEFAULT_CONFIG };
}

async function safeUnseatAndCreditIfIdle(){
  const uid = auth.currentUser?.uid;
  if(!uid || !currentRoomRef) return;
  await runTransaction(db, async tx => {
    const snap = await tx.get(currentRoomRef);
    if(!snap.exists()) return;
    const room = snap.data();
    if(room.state !== 'idle') return;
    const seat = room.players?.[uid]?.seat;
    if(seat == null) return;
    const seats = room.seats || [];
    const stackMap = room.stacks || {};
    const players = room.players || {};
    const stack = stackMap[uid] || 0;
    const wRef = doc(db,'wallets',uid);
    const wSnap = await tx.get(wRef);
    const bal = wSnap.data()?.balance || 0;
    seats[seat] = null;
    players[uid].seat = null;
    delete stackMap[uid];
    tx.update(wRef,{ balance: bal + stack });
    tx.update(currentRoomRef,{ seats, players, stacks: stackMap });
  });
}

async function maybeLockNextVariant(room, gate) {
  if (!room || room.state !== 'idle' || room.nextVariant) return;
  try {
    const res = await runTransaction(db, async (tx) => {
      const snap = await tx.get(currentRoomRef);
      if (!snap.exists()) throw { code: 'ROOM_MISSING' };
      const r = snap.data();
      if (r.state !== 'idle' || r.nextVariant) return { type: 'SKIP' };
      let dealerSeat = typeof r.dealerSeat === 'number' ? r.dealerSeat : null;
      if (dealerSeat == null) {
        const { seat } = deriveDealerSeat(r);
        dealerSeat = seat;
      }
      const dealerPid = r.seats?.[dealerSeat] || null;
      if (!dealerPid) return { type: 'SKIP' };
      const pref = r.players?.[dealerPid]?.variantPref;
      const value = pref === 'OMA' ? 'OMA' : 'HE';
      const update = {
        nextVariant: { value, dealerPid, lockedAt: serverTimestamp() }
      };
      if (r.dealerSeat == null) update.dealerSeat = dealerSeat;
      tx.update(currentRoomRef, update);
      return { type: 'LOCKED', value, dealerPid };
    });
    if (res?.type === 'LOCKED') {
      window.DEBUG?.log('variant.lock.next', { value: res.value, dealerPid: res.dealerPid });
    }
  } catch (e) {
    // ignore
  }
}

async function maybeAutoDeal(room, gate) {
  const uid = auth.currentUser?.uid;
  const lockedVariant = room?.nextVariant?.value || null;
  const isDealer = uid && room.nextVariant?.dealerPid === uid;
  window.DEBUG?.log('autodeal.eligibility', { isDealer: !!isDealer, state: room?.state || null, lockedVariant, activeSeated: gate?.activeSeated || 0 });
  if (!isDealer) return;
  if (room.state !== 'idle') return;
  if (!lockedVariant) return;
  if ((gate?.activeSeated || 0) < 2) return;
  if (!currentRoomRef) return;
  try {
    const res = await tryTxDealLock(db, currentRoomRef, uid);
    if (res?.type === 'LOCKED') {
      window.DEBUG?.log('hand.lock.tx.success', { handId: res.handId });
    } else if (res?.type === 'IDEMPOTENT') {
      window.DEBUG?.log('hand.lock.tx.idempotent', { handId: res.handId });
    }
  } catch (e) {
    window.DEBUG?.log('hand.lock.tx.error', { code: e.code || 'UNKNOWN', detail: e });
  }
}

async function maybeRunDeal(room) {
  const uid = auth.currentUser?.uid;
  if (!room || room.state !== 'dealLocked') return;
  if (!room.hand || (room.hand.status !== 'locked' && room.hand.status !== 'dealing')) return;
  if (room.hand.lockedBy !== uid) return;
  if (dealFlowRunning) return;
  dealFlowRunning = true;
  try {
    await runDealFlow(room);
  } finally {
    dealFlowRunning = false;
  }
}

async function runDealFlow(room) {
  const uid = auth.currentUser.uid;
  const roomRef = currentRoomRef;
  try {
    if (room.hand.status === 'locked') {
      await runTransaction(db, async (tx) => {
        const r = await tx.get(roomRef);
        const rm = r.data();
        if (rm.state !== 'dealLocked' || rm.hand?.status !== 'locked' || rm.hand.lockedBy !== uid) {
          throw { code: 'NOT_LOCK_OWNER' };
        }
        const now = serverTimestamp();
        const holeCount = rm.hand?.variant === 'OMA' ? 4 : 2;
        const nowMs = Date.now();
        const participants = [];
        const seatsArr = rm.seats || [];
        for (const pid of seatsArr) {
          if (!pid) continue;
          const p = rm.players?.[pid];
          const last = p?.lastSeen?.toMillis?.();
          const isActive = p?.active === true && typeof last === 'number' && (nowMs - last) <= PRESENCE.STALE_AFTER_MS;
          if (isActive) participants.push(pid);
        }
        tx.update(roomRef, {
          'hand.status': 'dealing',
          'hand.holeCount': holeCount,
          'hand.participants': participants,
          'hand.lockedAt': now,
          'hand.lockTTLms': Math.max(15000, DEAL_LOCK.TTL_MS)
        });
      });
    }

    const snap = await getDoc(roomRef);
    room = snap.data();
    const hand = room.hand;
    const participants = hand.participants || [];
    window.DEBUG?.log('hand.deal.begin', { handId: hand.id, participants: participants.length, holeCount: hand.holeCount });

    const deck = shuffledDeck(`${roomCode}:${hand.id}`);
    const order = [];
    const seats = room.seats || [];
    const seen = new Set();
    for (let i = 1; i <= 9; i++) {
      const idx = (hand.dealerSeat + i) % 9;
      const pid = seats[idx];
      if (pid && participants.includes(pid) && !seen.has(pid)) {
        order.push({ pid, seat: idx });
        seen.add(pid);
      }
    }

    const cardsByPid = {};
    let ptr = 0;
    for (let r = 0; r < hand.holeCount; r++) {
      for (const { pid } of order) {
        if (!cardsByPid[pid]) cardsByPid[pid] = [];
        cardsByPid[pid].push(deck[ptr++]);
      }
    }

    let writes = 0;
    const batch = writeBatch(db);
    for (const { pid, seat } of order) {
      const hRef = doc(db, 'rooms', roomCode, 'players', pid, 'hands', hand.id);
      const hSnap = await getDoc(hRef);
      if (!hSnap.exists()) {
        batch.set(hRef, {
          handId: hand.id,
          variant: hand.variant,
          cards: cardsByPid[pid],
          createdAt: serverTimestamp()
        });
        writes++;
        window.DEBUG?.log('hand.deal.private.write', { pid, seat, count: hand.holeCount });
      }
    }
    if (writes > 0) {
      await batch.commit();
    } else {
      window.DEBUG?.log('hand.deal.idempotent', { handId: hand.id });
    }

    await runTransaction(db, async (tx) => {
      const r = await tx.get(roomRef);
      const rm = r.data();
      if (rm.state !== 'dealLocked' || rm.hand?.status !== 'dealing' || rm.hand.lockedBy !== uid) {
        throw { code: 'OPEN_NOT_ALLOWED' };
      }
      tx.update(roomRef, {
        state: 'hand',
        hand: {
          ...rm.hand,
          status: 'preflop',
          street: 'preflop',
          dealtAt: serverTimestamp(),
          board: []
        }
      });
    });
    window.DEBUG?.log('hand.deal.commit.success', { handId: hand.id });
  } catch (e) {
    window.DEBUG?.log('hand.deal.error', { code: e.code || 'UNKNOWN' });
  }
}
