import { verifyCardAssets, resolveCardSrc } from './cards.js';
import { Debug } from './debug.js';

let roomCode = null;
let playerId = sessionStorage.getItem('playerId');
if (!playerId) {
  playerId = 'tab_' + Math.random().toString(36).slice(2, 6);
  sessionStorage.setItem('playerId', playerId);
}

document.getElementById('debug-player').textContent = playerId;
document.getElementById('debug-room').textContent = roomCode ?? '—';

const debug = new Debug({
  roomCodeGetter: () => roomCode,
  playerIdGetter: () => playerId
});
window.DEBUG = debug;

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

debug.log('app.init', { ua: navigator.userAgent });
debug.log('ui.debug.ready', { panel: 'open' });
