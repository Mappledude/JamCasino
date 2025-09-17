(function (global) {
  if (global.__BOOT_LOGGER_INIT__) return;
  global.__BOOT_LOGGER_INIT__ = true;

  const previous = global.BootLogger || {};
  const previousEmit = typeof previous.emit === 'function' ? previous.emit.bind(previous) : null;
  const previousEmitError = typeof previous.emitError === 'function' ? previous.emitError.bind(previous) : null;
  const previousRefresh = typeof previous.refreshBadge === 'function' ? previous.refreshBadge.bind(previous) : null;
  const previousLast = typeof previous.last === 'function' ? previous.last.bind(previous) : null;

  const MOBILE_UA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i;
  const BOOT_PREFIX = /^\[BOOT(?:\]\[ERR])?\]\s*/;
  const state = {
    last: '',
    pending: null,
    badge: null
  };

  const original = {
    log: global.console && global.console.log ? global.console.log.bind(global.console) : function () {},
    error: global.console && global.console.error ? global.console.error.bind(global.console) : function () {}
  };

  function locateBadge() {
    if (state.badge && state.badge.isConnected) return state.badge;
    state.badge = global.document ? global.document.getElementById('boot-badge') : null;
    return state.badge;
  }

  function normalise(line) {
    if (typeof line !== 'string') return '';
    const stripped = line.replace(BOOT_PREFIX, '').trim();
    return stripped || line.trim();
  }

  function applyBadge(text) {
    const badge = locateBadge();
    if (badge) {
      badge.textContent = text;
      badge.dataset.active = '1';
      state.pending = null;
    } else {
      state.pending = text;
    }
  }

  function handleBoot(line) {
    const text = normalise(line) || 'Booting…';
    state.last = text;
    applyBadge(text);
  }

  function inspectArgs(args) {
    for (const arg of args) {
      if (typeof arg === 'string' && BOOT_PREFIX.test(arg)) {
        handleBoot(arg);
        return true;
      }
    }
    return false;
  }

  function flushPending() {
    if (state.pending) applyBadge(state.pending);
  }

  function initBadge() {
    if (!global.document) return;
    if (MOBILE_UA.test(global.navigator?.userAgent || '')) {
      global.document.documentElement.classList.add('is-mobile-ua');
    }
    const badge = locateBadge();
    if (badge) {
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      const initial = state.last || state.pending || 'Booting…';
      applyBadge(initial);
    }
  }

  const BootLogger = {
    emit(message, ...rest) {
      if (typeof message === 'string') inspectArgs([message]);
      if (previousEmit) return previousEmit(message, ...rest);
      return original.log(message, ...rest);
    },
    emitError(message, ...rest) {
      if (typeof message === 'string') inspectArgs([message]);
      if (previousEmitError) return previousEmitError(message, ...rest);
      return original.error(message, ...rest);
    },
    last() {
      if (state.last) return state.last;
      return previousLast ? previousLast() : state.last;
    },
    refreshBadge() {
      if (previousRefresh) previousRefresh();
      if (state.last) {
        applyBadge(state.last);
      } else {
        flushPending();
      }
    }
  };

  if (global.console) {
    global.console.log = function (...args) {
      inspectArgs(args);
      return original.log(...args);
    };
    global.console.error = function (...args) {
      inspectArgs(args);
      return original.error(...args);
    };
  }

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', () => {
        initBadge();
        flushPending();
      });
    } else {
      initBadge();
      flushPending();
    }
  }

  global.BootLogger = Object.assign({}, previous, BootLogger);
})(window);
