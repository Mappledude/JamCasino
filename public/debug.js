export class Debug {
  constructor({ roomCodeGetter, playerIdGetter }) {
    this.roomCodeGetter = roomCodeGetter;
    this.playerIdGetter = playerIdGetter;
    this.logEl = document.getElementById('debug-log');
    this.autoScrollEl = document.getElementById('auto-scroll');
    this.autoScroll = this.autoScrollEl ? this.autoScrollEl.checked : true;
    if (this.autoScrollEl) {
      this.autoScrollEl.addEventListener('change', () => {
        this.autoScroll = this.autoScrollEl.checked;
        this.log('ui.debug.autoscroll.toggle', { enabled: this.autoScroll });
      });
    }
  }

  log(event, payload = {}) {
    const entry = {
      ts: new Date().toISOString(),
      roomCode: this.roomCodeGetter ? this.roomCodeGetter() : null,
      playerId: this.playerIdGetter ? this.playerIdGetter() : null,
      event,
      payload
    };
    console.log(entry);
    if (this.logEl) {
      const line = document.createElement('div');
      line.textContent = JSON.stringify(entry);
      this.logEl.appendChild(line);
      if (this.autoScroll) {
        this.logEl.scrollTop = this.logEl.scrollHeight;
      }
    }
  }
}
