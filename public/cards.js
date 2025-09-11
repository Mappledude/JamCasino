export const CARD_BACK_SRC = "/Images/Card_Deck-Back.png";

const rankOffset = {
  2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7,
  10: 8, J: 9, Q: 10, K: 11, A: 12
};

const base = { D: 1, C: 14, H: 27, S: 40 };

export function resolveCardSrc(rank, suit) {
  const index = base[suit] + rankOffset[rank];
  const filename = `Images/Card_Deck-${String(index).padStart(2, '0')}.png`;
  const src = "/" + filename;
  window.DEBUG?.log('cards.resolve', { rank, suit, index, src });
  return src;
}

export function verifyCardAssets() {
  const expected = ["Images/Card_Deck-Back.png"];
  for (let i = 1; i <= 52; i++) {
    expected.push(`Images/Card_Deck-${String(i).padStart(2, '0')}.png`);
  }
  window.DEBUG?.log('debug.assetCheck.start', { expected: expected.length });
  const missing = [];
  const checks = expected.map(f => new Promise(res => {
    const img = new Image();
    img.onload = () => res();
    img.onerror = () => { missing.push(f); res(); };
    img.src = "/" + f;
  }));
  return Promise.all(checks).then(() => {
    const logEl = document.getElementById('debug-log');
    const line = document.createElement('div');
    if (missing.length === 0) {
      window.DEBUG?.log('debug.assetCheck.ok', { count: expected.length });
      line.textContent = 'assets.cards.ok';
    } else {
      window.DEBUG?.log('debug.assetCheck.missing', { missing });
      line.textContent = 'assets.cards.missing';
    }
    if (logEl) {
      logEl.appendChild(line);
      if (document.getElementById('auto-scroll')?.checked) {
        logEl.scrollTop = logEl.scrollHeight;
      }
    }
  });
}
