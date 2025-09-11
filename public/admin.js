const db = firebase.firestore();
const auth = firebase.auth();

auth.signInAnonymously().catch(console.error);

const codeInput = document.getElementById('room-code');
const minBuyInput = document.getElementById('min-buy');
const maxBuyInput = document.getElementById('max-buy');
const sbInput = document.getElementById('sb');
const bbInput = document.getElementById('bb');
const createBtn = document.getElementById('create-table');
const logEl = document.getElementById('log');

function log(event, payload = {}) {
  const entry = { ts: new Date().toISOString(), event, payload };
  const div = document.createElement('div');
  div.textContent = JSON.stringify(entry);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(entry);
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

createBtn.onclick = async () => {
  const code = (codeInput.value || randomCode()).toUpperCase();
  const min = parseFloat(minBuyInput.value) || 10;
  const max = parseFloat(maxBuyInput.value) || 20;
  const sb = parseFloat(sbInput.value) || 0.25;
  const bb = parseFloat(bbInput.value) || 0.50;
  const roomRef = db.collection('rooms').doc(code);
  const existing = await roomRef.get();
  if (existing.exists) {
    log('admin.room.create.exists', { code });
    return;
  }
  await roomRef.set({
    code,
    state: 'idle',
    seats: Array(9).fill(null),
    players: {},
    dealerSeat: null,
    nextVariant: null,
    config: { minBuyIn: min, maxBuyIn: max, sb, bb },
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  log('admin.room.create.success', { code, config: { min, max, sb, bb } });
  const msg = document.createElement('div');
  msg.textContent = `Created table ${code}`;
  const openBtn = document.createElement('button');
  openBtn.textContent = 'Open Table';
  openBtn.onclick = () => location.href = `/table.html?room=${encodeURIComponent(code)}`;
  msg.appendChild(document.createElement('br'));
  msg.appendChild(openBtn);
  logEl.appendChild(msg);
};

document.getElementById('btn-delete-all')?.addEventListener('click', async () => {
  if (!confirm('Delete ALL rooms? This cannot be undone.')) return;
  if (!confirm('REALLY delete ALL rooms?')) return;
  try {
    await deleteAllRooms();
    alert('All rooms deleted.');
    window.DEBUG?.log('admin.rooms.deleteAll.success', {});
  } catch (e) {
    console.error(e);
    alert('Delete failed: ' + e.message);
    window.DEBUG?.log('admin.rooms.deleteAll.error', { message: e.message });
  }
});

async function deleteAllRooms() {
  const roomsSnap = await db.collection('rooms').get();
  for (const roomDoc of roomsSnap.docs) {
    const roomRef = roomDoc.ref;
    const data = roomDoc.data() || {};
    const pids = Object.keys(data.players || {});
    for (const pid of pids) {
      const handsRef = roomRef.collection(`players/${pid}/hands`);
      const handsSnap = await handsRef.get();
      let batch = db.batch(); let n = 0;
      for (const h of handsSnap.docs) {
        batch.delete(h.ref); n++;
        if (n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n) await batch.commit();
    }
    await roomRef.delete();
  }
}
