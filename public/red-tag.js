// === Verification script: adds a visible build tag and logs a stamp ===
(function() {
  var TAG = "UI-RED-v1";
  function addBadge() {
    var el = document.createElement("div");
    el.id = "___build_tag";
    el.textContent = "Build: " + TAG + "  •  jamcasino-36b9a.web.app";
    document.body.appendChild(el);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addBadge);
  } else {
    addBadge();
  }
  console.log("[JamCasino] Build:", TAG);
})();
