const bootState = window.__BOOT_LOG__ || { entries: [], last: null };
window.__BOOT_LOG__ = bootState;

function pushBootEntry(level, stage, payload) {
  const data = payload && Object.keys(payload).length ? payload : undefined;
  const prefix = level === 'error' ? '[BOOT][ERR]' : level === 'warn' ? '[BOOT][WARN]' : '[BOOT]';
  const line = data ? `${prefix} ${stage} ${JSON.stringify(data)}` : `${prefix} ${stage}`;
  console.log(line);
  const entry = { ts: Date.now(), level, stage, payload: data || null, line };
  bootState.entries.push(entry);
  bootState.last = entry;
  return entry;
}

function bootLog(stage, payload = {}) {
  return pushBootEntry('info', stage, payload);
}

function bootWarn(stage, payload = {}) {
  return pushBootEntry('warn', stage, payload);
}

function bootError(tag, error) {
  const info = {
    tag,
    code: error?.code || error?.name || 'ERR',
    message: error?.message || String(error),
    stack: error?.stack || null
  };
  const line = `[BOOT][ERR] tag=${info.tag} code=${info.code} message=${info.message} stack=${info.stack}`;
  console.log(line);
  const entry = { ts: Date.now(), level: 'error', stage: tag, payload: info, line };
  bootState.entries.push(entry);
  bootState.last = entry;
  return entry;
}

const db = firebase.firestore();
const auth = firebase.auth();
const qs = new URLSearchParams(location.search);
const rc = qs.get('room');
const routeInfo = { path: window.location.pathname, hash: window.location.hash || '' };
const EXPECTED_LOBBY_ROUTES = new Set(['/', '/index.html']);
let routeLogged = false;
let routeWarned = false;
let lobbyLogged = false;

bootLog('script start', { href: window.location.href, ua: navigator.userAgent });
bootLog('Firebase config success', { projectId: firebase.app()?.options?.projectId || null });
bootLog('auth start', { mode: 'anonymous' });

async function initLobby() {
  try {
    await auth.signInAnonymously();
  } catch (err) {
    bootError('lobby.auth.signIn', err);
    throw err;
  }

  const user = auth.currentUser;
  if (!user) return;
  bootLog('auth user', { uid: user.uid, mode: 'anonymous' });

  if (!routeLogged) {
    routeLogged = true;
    const payload = { path: routeInfo.path, hash: routeInfo.hash || null };
    bootLog('route start', payload);
    if (!EXPECTED_LOBBY_ROUTES.has(routeInfo.path) && !routeWarned) {
      routeWarned = true;
      bootWarn('unexpected route', payload);
    }
  }

  if (!lobbyLogged) {
    lobbyLogged = true;
    const grid = document.getElementById('rooms-grid');
    bootLog('lobby mount', { hasGrid: !!grid });
  }

  if (rc) {
    location.replace(`/table.html?room=${encodeURIComponent(rc)}`);
    return;
  }

  try {
    const wref = db.collection('wallets').doc(user.uid);
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
  } catch (err) {
    bootError('lobby.wallet', err);
    throw err;
  }

  const q = db.collection('rooms').orderBy('createdAt', 'desc');
  q.onSnapshot((snap) => {
    try {
      const grid = document.getElementById('rooms-grid');
      grid.innerHTML = '';
      snap.forEach((d) => {
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
      grid.querySelectorAll('.join-btn').forEach((b) => {
        b.onclick = () => {
          bootLog('join-click', { code: b.dataset.code });
          location.href = `/table.html?room=${encodeURIComponent(b.dataset.code)}`;
        };
      });
      window.DEBUG?.log('lobby.rooms.render', { ts: new Date().toISOString(), count: snap.size });
    } catch (err) {
      bootError('lobby.rooms.snapshot', err);
      throw err;
    }
  });
}

initLobby().catch((err) => {
  bootError('lobby.init', err);
});
