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

    this.filterEl = document.getElementById('debug-filter');
    const stored = localStorage.getItem('debug.filter.groups');
    this.enabledGroups = new Set(stored ? JSON.parse(stored) : ['ui','hand','betting','street','settle','presence']);
    if (this.filterEl) {
      this.filterEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        const g = cb.dataset.group;
        cb.checked = this.enabledGroups.has(g);
        cb.addEventListener('change', () => {
          if (cb.checked) this.enabledGroups.add(g); else this.enabledGroups.delete(g);
          localStorage.setItem('debug.filter.groups', JSON.stringify([...this.enabledGroups]));
          this.log('ui.debug.filter.change', { enabled: [...this.enabledGroups] });
        });
      });
    }
  }

  log(event, payload = {}) {
    const group = event.split('.')[0];
    if (this.filterEl && this.filterEl.querySelector(`input[data-group="${group}"]`)) {
      if (this.enabledGroups && !this.enabledGroups.has(group)) return;
    }
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
