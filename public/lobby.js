import { Debug } from './debug.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const debug = new Debug({});
window.DEBUG = debug;

debug.log('lobby.init', { ua: navigator.userAgent });

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
  const balEl = document.getElementById('wallet-balance');
  if(balEl) balEl.textContent = `Wallet: $${walletBalance}`;
}

onAuthStateChanged(auth, async user => {
  if(!user) return;
  await ensureWallet(user.uid);
  loadRooms();
});

function loadRooms(){
  const q = query(collection(db,'rooms'), orderBy('createdAt','desc'));
  onSnapshot(q, snap => {
    const list = document.getElementById('rooms');
    list.innerHTML='';
    snap.forEach(docSnap => {
      const room = docSnap.data();
      const card = document.createElement('div');
      card.className = 'room-card';
      const info = document.createElement('div');
      const seats = (room.seats || []).filter(Boolean).length;
      const cfg = room.config || {};
      info.textContent = `${room.code} — ${seats}/9 seats — $${cfg.minBuyIn||10}-$${cfg.maxBuyIn||20} — ${cfg.sb||0.25}/${cfg.bb||0.50} — ${room.state}`;
      const btn = document.createElement('button');
      btn.textContent = 'Join';
      const min = cfg.minBuyIn || 10;
      if(walletBalance < min){
        btn.disabled = true;
        btn.title = 'Insufficient balance';
      }else{
        btn.onclick = () => {
          location.href = `/index.html?room=${encodeURIComponent(room.code)}`;
        };
      }
      card.appendChild(info);
      card.appendChild(btn);
      list.appendChild(card);
    });
    debug.log('lobby.rooms.render',{ count:snap.size });
  });
}
