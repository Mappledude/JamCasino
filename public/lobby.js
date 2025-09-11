const db = firebase.firestore(), auth = firebase.auth();
const qs = new URLSearchParams(location.search); const rc = qs.get('room');
if (rc) location.replace(`/table.html?room=${encodeURIComponent(rc)}`);
auth.signInAnonymously().then(async () => {
  const uid = auth.currentUser.uid;
  const wref = db.collection('wallets').doc(uid);
  const w = await wref.get();
  if (!w.exists) {
    await wref.set({
      balance: 100,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  const balSnap = await wref.get();
  document.getElementById('wallet-balance').textContent = balSnap.data().balance.toFixed(2);

  const q = db.collection('rooms').orderBy('createdAt', 'desc');
  q.onSnapshot(snap => {
    const grid = document.getElementById('rooms-grid'); grid.innerHTML = '';
    snap.forEach(d => {
      const r = d.data(); const seatsUsed = (r.seats || []).filter(Boolean).length;
      const cfg = r.config || {}, min = cfg.minBuyIn ?? 10, max = cfg.maxBuyIn ?? 20, sb = cfg.sb ?? 0.25, bb = cfg.bb ?? 0.50;
      const div = document.createElement('div'); div.className = 'room-card';
      div.innerHTML = `
        <div class="room-row"><strong>${r.code}</strong><span>${seatsUsed}/9</span></div>
        <div class="room-row">$${min}–$${max} • SB $${sb} / BB $${bb}</div>
        <div class="room-row">Status: ${r.state || 'idle'}</div>
        <button class="join-btn" data-code="${r.code}">Join</button>`;
      grid.appendChild(div);
    });
    grid.querySelectorAll('.join-btn').forEach(b => b.onclick = () => location.href = `/table.html?room=${encodeURIComponent(b.dataset.code)}`);
    window.DEBUG?.log('lobby.rooms.render', { ts: new Date().toISOString(), count: snap.size });
  });
});
