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
