import { Debug } from './debug.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const debug = new Debug({});
window.DEBUG = debug;

debug.log('nav.lobby.loaded', { url: location.href });

// redirect if ?room=CODE accidentally hits index
const rc = new URLSearchParams(location.search).get('room');
if (rc) {
  location.replace(`/table.html?room=${encodeURIComponent(rc)}`);
}

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

await signInAnonymously(auth);

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  await ensureWallet(user.uid);
  subscribeRooms();
});

async function ensureWallet(uid) {
  const wRef = doc(db, 'wallets', uid);
  const snap = await getDoc(wRef);
  let bal = 0;
  if (!snap.exists()) {
    await setDoc(wRef, { balance: 100 });
    bal = 100;
  } else {
    bal = snap.data().balance || 0;
  }
  const badge = document.getElementById('wallet-balance');
  if (badge) badge.textContent = bal;
}

function subscribeRooms() {
  const q = query(collection(db, 'rooms'), orderBy('createdAt', 'desc'));
  onSnapshot(q, (snap) => {
    const grid = document.getElementById('rooms-grid');
    if (!grid) return;
    grid.innerHTML = '';
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      const seatsUsed = (r.seats || []).filter(Boolean).length;
      const min = r?.config?.minBuyIn ?? 10;
      const max = r?.config?.maxBuyIn ?? 20;
      const sb = r?.config?.sb ?? 0.25;
      const bb = r?.config?.bb ?? 0.50;
      const card = document.createElement('div');
      card.className = 'room-card';
      card.innerHTML = `
        <div class="room-row"><strong>${r.code}</strong><span>${seatsUsed}/9</span></div>
        <div class="room-row">$${min}–$${max} • SB $${sb} / BB $${bb}</div>
        <div class="room-row">Status: ${r.state || 'idle'}</div>
        <button class="join-btn" data-code="${r.code}">Join</button>
      `;
      grid.appendChild(card);
    });
    document.querySelectorAll('.join-btn').forEach((b) => {
      b.onclick = () => {
        const code = b.dataset.code;
        location.href = `/table.html?room=${encodeURIComponent(code)}`;
      };
    });
    debug.log('lobby.rooms.render', { count: snap.size });
  });
}
