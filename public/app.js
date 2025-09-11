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

let roomCode = null;

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
  for (let i = 0; i < 9; i++) {
    const seatEl = document.querySelector(`.seat-${i}`);
    if (!seatEl) continue;
    const nameEl = seatEl.querySelector('.name');
    const stackEl = seatEl.querySelector('.stack');
    const uid = data.seats ? data.seats[i] : null;
    if (uid) {
      nameEl.textContent = data.players?.[uid]?.displayName || 'Player';
      let statusEl = seatEl.querySelector('.status');
      if (!statusEl) {
        statusEl = document.createElement('span');
        statusEl.className = 'status';
        nameEl.after(statusEl);
      }
      statusEl.textContent = 'idle';
      stackEl.textContent = '$—';
    } else {
      nameEl.textContent = `Seat ${i + 1} (empty)`;
      const statusEl = seatEl.querySelector('.status');
      if (statusEl) statusEl.remove();
      stackEl.textContent = '$—';
    }
  }
}
