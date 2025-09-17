(function(global) {
  const state = {
    stageText: '',
    errorText: null,
    bannerId: 'fs-error-banner',
    badgeId: 'boot-overlay-badge'
  };

  function getBannerEl() {
    return global.document?.getElementById(state.bannerId) || null;
  }

  function getBadgeEl() {
    return global.document?.getElementById(state.badgeId) || null;
  }

  function updateBadge(text) {
    const badge = getBadgeEl();
    if (!badge) return;
    if (text) {
      badge.textContent = text;
      badge.classList.remove('hidden');
    } else {
      badge.textContent = '';
      badge.classList.add('hidden');
    }
  }

  function setStage(text) {
    state.stageText = text || '';
    if (!state.errorText) {
      updateBadge(state.stageText);
    }
  }

  function showBanner(message) {
    const banner = getBannerEl();
    if (!banner) return;
    banner.textContent = message;
    banner.classList.remove('hidden');
    state.errorText = message;
    updateBadge(message);
  }

  function clearBanner() {
    const banner = getBannerEl();
    if (!banner) return;
    banner.textContent = '';
    banner.classList.add('hidden');
    state.errorText = null;
    updateBadge(state.stageText);
  }

  function extractErrorDetails(err) {
    if (!err) {
      return { code: 'unknown', message: 'Unknown error' };
    }
    const code = typeof err.code === 'string' ? err.code : (typeof err.name === 'string' ? err.name : 'unknown');
    const message = typeof err.message === 'string' ? err.message : String(err);
    return { code, message };
  }

  function reportError(tag, scope, err) {
    const { code, message } = extractErrorDetails(err);
    const parts = [`[BOOT][ERR] tag=${tag}`];
    if (scope) parts.push(`scope=${scope}`);
    if (code) parts.push(`code=${code}`);
    if (message) parts.push(`message=${message}`);
    const text = parts.join(' ');
    console.error(text);
    if (code === 'permission-denied') {
      showBanner(`${code}: ${message}`);
    }
    return { text, code, message };
  }

  const api = {
    setStage,
    clearFsError: clearBanner,
    setBootBadge(text) {
      state.stageText = text || state.stageText;
      if (!state.errorText) updateBadge(text);
    },
    reportFsListenerError(scope, err) {
      return reportError('fs-listener', scope, err);
    },
    reportFsOpError(scope, err) {
      return reportError('fs-op', scope, err);
    },
    showFsErrorBanner(message) {
      showBanner(message);
    }
  };

  global.BootDiagnostics = Object.assign(global.BootDiagnostics || {}, api);
})(window);
