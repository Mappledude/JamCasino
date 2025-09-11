import { verifyCardAssets, resolveCardSrc, resolveCardSrcByIndex, CARD_BACK_SRC } from './cards.js';
import { Debug } from './debug.js';
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
  serverTimestamp, updateDoc, writeBatch, getDoc,
  collection, addDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

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

let roomCode = null;
let heartbeatTimer = null;
let sweeperTimer = null;
let dealLockSweeperTimer = null;
let currentRoomRef = null;
let currentRoom = null;
let derivedDealerSeat = null;
let activeSeated = 0;
let lastGateReason = null;
let dealFlowRunning = false;
let myHandUnsub = null;
let myHandId = null;
let myHandCards = null;

document.getElementById('debug-room').textContent = roomCode ?? '—';

const debug = new Debug({
  roomCodeGetter: () => roomCode,
  playerIdGetter: () => window.APP?.playerId || null
});
window.DEBUG = debug;

debug.log('app.init', { ua: navigator.userAgent });
debug.log('ui.debug.ready', { panel: 'open' });

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

await setPersistence(auth, browserSessionPersistence);
await signInAnonymously(auth);

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  window.APP = window.APP || {};
  window.APP.playerId = user.uid;

  const playerSpan = document.getElementById('player-id');
  if (playerSpan) playerSpan.textContent = user.uid;
  const debugPlayer = document.getElementById('debug-player');
  if (debugPlayer) debugPlayer.textContent = user.uid;

  window.DEBUG?.log('firebase.init.ok', { appName: app.name });
  window.DEBUG?.log('auth.anon.signIn.success', { uid: user.uid, persistence: 'session' });
  window.DEBUG?.log('auth.state', { uid: user.uid });
});

document.getElementById('asset-check').addEventListener('click', () => {
  verifyCardAssets();
});

document.getElementById('preview-btn').addEventListener('click', () => {
  const rank = document.getElementById('test-rank').value;
  const suit = document.getElementById('test-suit').value;
  const src = resolveCardSrc(rank, suit);
  const img = document.createElement('img');
  img.src = src;
  const container = document.getElementById('card-preview');
  container.innerHTML = '';
  container.appendChild(img);
});

// --- Gated controls ---
const dealBtn = document.getElementById('deal');
const variantSelect = document.getElementById('variant');
if (variantSelect) {
  if (variantSelect.options[0]) variantSelect.options[0].value = 'HE';
  if (variantSelect.options[1]) variantSelect.options[1].value = 'OMA';
}
const headerEl = document.querySelector('header');
let nextStreetBtn = document.getElementById('btn-next-street');
if (!nextStreetBtn) {
  nextStreetBtn = document.createElement('button');
  nextStreetBtn.id = 'btn-next-street';
  nextStreetBtn.disabled = true;
  nextStreetBtn.title = 'Dealer only';
  nextStreetBtn.textContent = 'Next Street';
  if (variantSelect && variantSelect.parentNode) {
    variantSelect.parentNode.insertBefore(nextStreetBtn, variantSelect);
  } else {
    headerEl?.appendChild(nextStreetBtn);
  }
}
const lockInfoEl = document.createElement('span');
lockInfoEl.id = 'lock-info';
lockInfoEl.className = 'lock-info';
headerEl?.appendChild(lockInfoEl);

const actionBar = document.querySelector('#my-board .action-bar');
const foldBtn = actionBar?.children[0] || null;
const checkBtn = actionBar?.children[1] || null;
const betBtn = actionBar?.children[2] || null;
if (foldBtn) foldBtn.title = 'Coming soon';
if (betBtn) betBtn.title = 'Coming soon';

const uiDealLock = { active: false, timer: null, TTL_MS: 3000 };
function setUiDealLock(on) {
  if (on) {
    if (uiDealLock.active) return;
    uiDealLock.active = true;
    window.DEBUG?.log('hand.lock.ui.set', { ttl: uiDealLock.TTL_MS });
    uiDealLock.timer = setTimeout(() => {
      uiDealLock.active = false;
      uiDealLock.timer = null;
      window.DEBUG?.log('hand.lock.ui.release', {});
      renderGatedControls();
    }, uiDealLock.TTL_MS);
  } else {
    if (!uiDealLock.active) return;
    clearTimeout(uiDealLock.timer);
    uiDealLock.active = false;
    uiDealLock.timer = null;
    window.DEBUG?.log('hand.lock.ui.release', { manual: true });
    renderGatedControls();
  }
}

function computeEarliestJoinerSeatFromRoom(room) {
  const { players = {}, seats = [] } = room || {};
  let best = null;
  Object.entries(players).forEach(([pid, p]) => {
    const seatIdx = (p && typeof p.seat === 'number') ? p.seat : null;
    if (seatIdx == null) return;
    const ts = p?.joinedAt?.toMillis?.() ?? p?.lastSeen?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
    if (!best || ts < best.joinedAtMillis) best = { pid, seatIdx, joinedAtMillis: ts };
  });
  return best ? best.seatIdx : null;
}

function countActiveSeated(room, nowMs, staleMs) {
  const players = room?.players || {};
  let n = 0;
  for (const p of Object.values(players)) {
    if (typeof p?.seat !== 'number') continue;
    const last = p?.lastSeen?.toMillis?.() ?? 0;
    const active = p?.active === true && (nowMs - last) <= staleMs;
    if (active) n++;
  }
  return n;
}

function isLockExpired(hand, nowMs) {
  const atMs = hand?.lockedAt?.toMillis?.() ?? 0;
  const ttl = hand?.lockTTLms ?? DEAL_LOCK.TTL_MS;
  return nowMs - atMs > ttl;
}

function seedFromStrings(a, b) {
  let h = 2166136261 >>> 0;
  const s = `${a}#${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledDeck(seed) {
  const deck = Array.from({ length: 52 }, (_, i) => i + 1);
  const rand = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function computeBoardNext(room, hand) {
  const N = (hand.participants || []).length;
  const holeCount = hand.holeCount || (hand.variant === 'OMA' ? 4 : 2);
  const consumedHole = N * holeCount;

  const seed = seedFromStrings(room.code, hand.id);
  const deck = shuffledDeck(seed);

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

    if (!room.variant) throw { code: 'NO_VARIANT' };

    const dealerSeat = (typeof room.dealerSeat === 'number')
      ? room.dealerSeat
      : computeEarliestJoinerSeatFromRoom(room);

    const mySeat = room.players?.[uid]?.seat ?? null;
    if (mySeat !== dealerSeat) throw { code: 'NOT_DEALER' };

    const activeSeated = countActiveSeated(room, nowMs, PRESENCE.STALE_AFTER_MS);
    if (activeSeated < 2) throw { code: 'PLAYERS_LT_2', activeSeated };

    const handId = `${Date.now()}_${uid.slice(0,6)}_${Math.floor(Math.random()*1e4)}`;
    const hand = {
      id: handId,
      status: 'locked',
      variant: room.variant,
      dealerSeat,
      dealerPid: room.seats?.[dealerSeat] ?? null,
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
}

function renderGatedControls() {
  const state = currentRoom?.state;
  const variant = currentRoom?.variant || null;
  const uid = auth.currentUser?.uid;
  const mySeat = currentRoom?.players?.[uid]?.seat ?? null;
  const handStatus = currentRoom?.hand?.status || null;
  const isDealer = mySeat != null && derivedDealerSeat != null && mySeat === derivedDealerSeat;

  let reason = null;
  if (state === 'dealLocked') reason = 'lockHeld';
  else if (!isDealer) reason = 'notDealer';
  else if (state !== 'idle') reason = 'notIdle';
  else if (activeSeated < 2) reason = 'players<2';
  else if (!(variant === 'HE' || variant === 'OMA')) reason = 'noVariant';
  else if (uiDealLock.active) reason = 'uiLock';

  lastGateReason = reason;

  if (dealBtn) {
    dealBtn.disabled = reason !== null;
    dealBtn.setAttribute('aria-busy', uiDealLock.active ? 'true' : 'false');
    let title = '';
    if (reason === 'notDealer') title = 'Dealer only';
    else if (reason === 'notIdle') title = 'Hand in progress';
    else if (reason === 'players<2') title = 'Need at least 2 active players';
    else if (reason === 'noVariant') title = 'Select a variant';
    else if (reason === 'uiLock') title = 'Please wait…';
    else if (reason === 'lockHeld') title = 'Hand lock in progress';
    dealBtn.title = title;
  }

  if (variantSelect) {
    const variantEnabled = isDealer && state === 'idle';
    variantSelect.disabled = !variantEnabled;
    let vTitle = '';
    if (!isDealer) vTitle = 'Dealer only';
    else if (state === 'dealLocked') vTitle = 'Hand lock in progress';
    else if (state !== 'idle') vTitle = 'Hand in progress';
    variantSelect.title = vTitle;
    if (variant) {
      variantSelect.value = variant;
    } else {
      variantSelect.value = '';
      variantSelect.selectedIndex = -1;
    }
  }

  if (nextStreetBtn) {
    let nsReason = null;
    if (uiDealLock.active) nsReason = 'uiLock';
    else if (state !== 'hand') nsReason = 'noHand';
    else if (!isDealer) nsReason = 'notDealer';
    else if (!['preflop', 'flop', 'turn'].includes(handStatus)) nsReason = 'complete';

    nextStreetBtn.disabled = nsReason !== null;
    let nsTitle = '';
    if (nsReason === 'notDealer') nsTitle = 'Dealer only';
    else if (nsReason === 'noHand') nsTitle = 'No hand in progress';
    else if (nsReason === 'complete') nsTitle = 'All streets revealed';
    else if (nsReason === 'uiLock') nsTitle = 'Please wait…';
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

  window.DEBUG?.log('ui.gate.evaluate', {
    isDealer,
    state,
    activeSeated,
    variant: variant,
    uiLock: uiDealLock.active,
    handStatus
  });
}

function renderActionControls(room) {
  const uid = auth.currentUser?.uid;
  const turn = room?.hand?.turn;
  const streetMatch = room?.state === 'hand' && turn && room.hand?.status === turn.street;
  const order = turn?.order || [];
  const currentPid = streetMatch ? order[turn.index] || null : null;
  const myTurn = streetMatch && currentPid === uid && turn.roundComplete !== true;
  if (foldBtn) foldBtn.disabled = true;
  if (betBtn) betBtn.disabled = true;
  if (checkBtn) {
    checkBtn.disabled = !myTurn;
    checkBtn.textContent = 'Check';
    checkBtn.title = myTurn ? '' : 'Not your turn';
  }
  const myBoard = document.getElementById('my-board');
  if (myBoard) myBoard.classList.toggle('my-turn', myTurn);
  window.DEBUG?.log('ui.actions.gate.evaluate', {
    myTurn,
    currentPid,
    street: turn?.street || null,
    index: turn?.index ?? null,
    orderLen: order.length
  });
}

if (dealBtn) {
  dealBtn.addEventListener('click', async () => {
    if (dealBtn.disabled) {
      window.DEBUG?.log('ui.deal.click.blocked', { reason: lastGateReason || 'uiLock' });
      return;
    }
    window.DEBUG?.log('ui.deal.click', { variant: currentRoom?.variant || null });
    setUiDealLock(true);
    renderGatedControls();
    if (!currentRoomRef) return;
    try {
      const res = await tryTxDealLock(db, currentRoomRef, auth.currentUser.uid);
      if (res?.type === 'LOCKED') {
        window.DEBUG?.log('hand.lock.tx.success', { handId: res.handId });
      } else if (res?.type === 'IDEMPOTENT') {
        window.DEBUG?.log('hand.lock.tx.idempotent', { handId: res.handId });
      }
    } catch (e) {
      window.DEBUG?.log('hand.lock.tx.error', { code: e.code || 'UNKNOWN', detail: e });
    }
  });
}

if (variantSelect) {
  variantSelect.addEventListener('change', async (e) => {
    const value = e.target.value;
    if (!currentRoomRef) return;
    try {
      await updateDoc(currentRoomRef, { variant: value });
      window.DEBUG?.log('variant.select', { value });
    } catch (err) {
      // ignore
    }
    if (currentRoom) currentRoom.variant = value;
    renderGatedControls();
  });
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
          version: (hand.turn?.version || 0) + 1
        };
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

if (checkBtn) {
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    const room = currentRoom;
    const turn = room?.hand?.turn;
    const uid = auth.currentUser?.uid;
    const street = turn?.street;
    const handId = room?.hand?.id;
    const currentPid = turn?.order?.[turn.index] || null;
    if (room?.state !== 'hand' || room.hand?.status !== street || currentPid !== uid) return;
    try {
      const actionsRef = collection(db, 'rooms', roomCode, 'hands', handId, 'actions');
      await addDoc(actionsRef, { pid: uid, street, type: 'check', ts: serverTimestamp() });
      window.DEBUG?.log('action.intent.check', { street, pid: uid });
    } catch (e) {
      window.DEBUG?.log('action.intent.check.error', { code: e.code || 'UNKNOWN' });
      return;
    }
    try {
      const res = await runTransaction(db, async (tx) => {
        const snap = await tx.get(currentRoomRef);
        if (!snap.exists()) throw { code: 'ROOM_MISSING' };
        const data = snap.data();
        if (data.state !== 'hand') throw { code: 'NOT_IN_HAND' };
        const h = data.hand || {};
        const t = h.turn || {};
        const cp = t.order?.[t.index] || null;
        const orderLen = (t.order || []).length;
        if (h.status !== street || cp !== uid) {
          throw { code: 'TURN_MISMATCH' };
        }
        let newIndex = t.index + 1;
        let roundComplete = false;
        if (newIndex >= orderLen) {
          roundComplete = true;
          newIndex = 0;
        }
        tx.update(currentRoomRef, {
          'hand.turn.index': newIndex,
          'hand.turn.roundComplete': roundComplete
        });
        return { index: newIndex, orderLen, roundComplete };
      });
      window.DEBUG?.log('turn.advance.index', { street, index: res.index, orderLen: res.orderLen });
      if (res.roundComplete) window.DEBUG?.log('turn.round.complete', { street });
    } catch (e) {
      if (e.code === 'TURN_MISMATCH') {
        window.DEBUG?.log('action.intent.idempotent', { street });
      } else {
        window.DEBUG?.log('turn.advance.error', { code: e.code || 'UNKNOWN' });
      }
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
  joinOverlay.classList.remove('hidden');
  joinError.textContent = '';
  displayNameInput.classList.remove('invalid');
  roomCodeInput.classList.remove('invalid');
  setTimeout(() => displayNameInput.focus(), 0);
  debug.log('ui.join.open', {});
}

function closeJoin() {
  joinOverlay.classList.add('hidden');
}

if (openJoinBtn) {
  openJoinBtn.addEventListener('click', openJoin);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeJoin();
  }
});

document.getElementById('create-room').addEventListener('click', () => submitJoin('create'));
document.getElementById('join-room').addEventListener('click', () => submitJoin('join'));

function startHeartbeat(roomRef, uid) {
  const tick = () => {
    updateDoc(roomRef, {
      [`players.${uid}.lastSeen`]: serverTimestamp(),
      [`players.${uid}.active`]: true
    });
    window.DEBUG?.log('presence.heartbeat.tick', { interval: PRESENCE.HEARTBEAT_MS });
  };
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

function startEvictionSweeper(roomRef, uid) {
  clearInterval(sweeperTimer);
  sweeperTimer = setInterval(() => {
    attemptEvict(roomRef, uid);
  }, PRESENCE.SWEEP_INTERVAL_MS);
}

let roomUnsub = null;

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
          variant: null,
          dealerSeat: null,
          seats: [null, null, null, null, null, null, null, null, null],
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
          lastSeen: serverTimestamp()
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
    document.getElementById('debug-room').textContent = code;
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

function renderRoom(data) {
  currentRoom = data;
  activeSeated = countActiveSeated(data, Date.now(), PRESENCE.STALE_AFTER_MS);
  ensureMyHandListener(data);
  maybeInitTurn(data);
  let source = 'none';
  if (data.state === 'idle') {
    if (typeof data.dealerSeat === 'number') {
      derivedDealerSeat = data.dealerSeat;
      source = 'room';
    } else {
      derivedDealerSeat = computeEarliestJoinerSeatFromRoom(data);
      source = derivedDealerSeat == null ? 'none' : 'derived';
    }
  } else if (data.state === 'dealLocked') {
    derivedDealerSeat = data.hand?.dealerSeat ?? null;
    source = derivedDealerSeat == null ? 'none' : 'hand';
  } else if (data.state === 'hand') {
    derivedDealerSeat = data.hand?.dealerSeat ?? null;
    source = derivedDealerSeat == null ? 'none' : 'hand';
  } else {
    derivedDealerSeat = null;
  }
  window.DEBUG?.log('dealer.compute', { derivedSeat: derivedDealerSeat, source });

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
    const badgesEl = seatEl.querySelector('.badges');
    const sIdx = serverSeatForUi(uiIndex);
    const pid = data.seats ? data.seats[sIdx] : null;
    if (pid) {
      const player = data.players?.[pid] || {};
      nameEl.textContent = pid === uid ? `${player.displayName || 'Player'} (you)` : (player.displayName || 'Player');
      let dotEl = seatEl.querySelector('.status-dot');
      if (!dotEl) {
        dotEl = document.createElement('span');
        dotEl.className = 'status-dot';
        nameEl.after(dotEl);
      }
      dotEl.className = `status-dot ${player.active ? 'active' : 'inactive'}`;
      stackEl.textContent = '$—';
      seatEl.classList.toggle('me', pid === uid);
    } else {
      nameEl.textContent = `Seat ${sIdx + 1} (empty)`;
      const dotEl = seatEl.querySelector('.status-dot');
      if (dotEl) dotEl.remove();
      stackEl.textContent = '$—';
      seatEl.classList.remove('me');
    }
    seatEl.classList.toggle('turn', pid && pid === currentPid);

    let dealerEl = badgesEl.querySelector('.dealer-btn');
    if ((data.state === 'idle' || data.state === 'dealLocked') && derivedDealerSeat != null && sIdx === derivedDealerSeat) {
      if (!dealerEl) {
        dealerEl = document.createElement('span');
        dealerEl.className = 'dealer-btn';
        dealerEl.textContent = 'D';
        badgesEl.appendChild(dealerEl);
      }
      dealerEl.style.display = 'inline-block';
    } else {
      if (dealerEl) dealerEl.remove();
    }

    const existingHole = seatEl.querySelector('.hole-cards');
    if (data.state === 'hand' && data.hand?.status === 'preflop' && pid && (data.hand.participants || []).includes(pid)) {
      let holeEl = existingHole;
      if (!holeEl) {
        holeEl = document.createElement('div');
        holeEl.className = 'hole-cards';
        holeEl.style.display = 'flex';
        holeEl.style.gap = '4px';
        seatEl.appendChild(holeEl);
      }
      const holeCount = data.hand.holeCount || 2;
      for (let i = 0; i < holeCount; i++) {
        let slot = holeEl.children[i];
        if (!slot) {
          slot = document.createElement('div');
          slot.className = 'card-slot';
          holeEl.appendChild(slot);
        }
        const cardIndex = (pid === uid && myHandCards && myHandCards[i]) ? myHandCards[i] : null;
        const src = cardIndex ? resolveCardSrcByIndex(cardIndex) : CARD_BACK_SRC;
        slot.style.backgroundImage = `url(${src})`;
        slot.classList.remove('empty');
      }
      while (holeEl.children.length > holeCount) holeEl.removeChild(holeEl.lastChild);
    } else {
      if (existingHole) existingHole.remove();
    }
  }

  if (turnStreetMatch) {
    window.DEBUG?.log('turn.render.current', { street: turn.street, currentPid, index: turnIndex, orderLen });
  }

  const board = data.hand?.board || [];
  const boardEl = document.getElementById('board');
  if (boardEl) {
    for (let i = 0; i < 5; i++) {
      const slot = boardEl.children[i];
      if (!slot) continue;
      const cardIndex = board[i];
      if (cardIndex) {
        slot.style.backgroundImage = `url(${resolveCardSrcByIndex(cardIndex)})`;
        slot.classList.remove('empty');
      } else {
        slot.style.backgroundImage = '';
        slot.classList.add('empty');
      }
    }
    window.DEBUG?.log('ui.board.render', { count: board.length, status: data.hand?.status || null });
  }

  if (data.state === 'hand' && data.hand?.status === 'preflop') {
    window.DEBUG?.log('ui.hole.render.others', { holeCount: data.hand.holeCount || 0 });
  }

  renderGatedControls();
  renderActionControls(data);
  maybeRunDeal(data);
}

function renderMyHoleCards(cards = [], holeCount = 0) {
  const container = document.querySelector('#my-board .hole-cards');
  if (!container) return;
  for (let i = 0; i < 4; i++) {
    let slot = container.children[i];
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'card-slot';
      container.appendChild(slot);
    }
    if (cards[i]) {
      slot.style.backgroundImage = `url(${resolveCardSrcByIndex(cards[i])})`;
      slot.classList.remove('empty');
    } else if (i < holeCount) {
      slot.style.backgroundImage = `url(${CARD_BACK_SRC})`;
      slot.classList.remove('empty');
    } else {
      slot.style.backgroundImage = '';
      slot.classList.add('empty');
    }
  }
}

function ensureMyHandListener(room) {
  const uid = auth.currentUser?.uid;
  const handId = room?.hand?.id;
  if (!uid || !roomCode || !handId) {
    if (myHandUnsub) myHandUnsub();
    myHandUnsub = null;
    myHandId = null;
    myHandCards = null;
    renderMyHoleCards([]);
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
      renderMyHoleCards(myHandCards, room.hand?.holeCount || 0);
      window.DEBUG?.log('hand.private.listen.ready', { handId });
      window.DEBUG?.log('ui.hole.render.mine', { cards: myHandCards });
      renderRoom(currentRoom);
    }
  });
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
        const holeCount = rm.variant === 'OMA' ? 4 : 2;
        const seatedPids = (rm.seats || []).filter(Boolean);
        const participants = seatedPids;
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
    window.DEBUG?.log('hand.deal.begin', { handId: hand.id, participants: participants.length });

    const deck = shuffledDeck(seedFromStrings(roomCode, hand.id));
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
