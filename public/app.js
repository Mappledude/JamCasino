import { verifyCardAssets, resolveCardSrc } from './cards.js';
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
  getFirestore, doc, getDoc, setDoc, runTransaction, onSnapshot,
  serverTimestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const PRESENCE = {
  HEARTBEAT_MS: 10_000,
  STALE_AFTER_MS: 45_000,
  SWEEP_INTERVAL_MS: 15_000,
  LOCK_TTL_MS: 20_000
};

let roomCode = null;
let heartbeatTimer = null;
let sweeperTimer = null;

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
    await updateDoc(roomRef, {
      [`players.${uid}.lastSeen`]: serverTimestamp(),
      [`players.${uid}.active`]: true
    });

    startHeartbeat(roomRef, uid);
    startEvictionSweeper(roomRef, uid);

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

function renderRoom(data) {
  const uid = auth.currentUser?.uid;
  const mySeat = data.players?.[uid]?.seat ?? null;
  const serverSeatForUi = (uiIndex) => {
    if (mySeat == null) return uiIndex;
    return (mySeat + uiIndex) % 9;
  };

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
  }
}
