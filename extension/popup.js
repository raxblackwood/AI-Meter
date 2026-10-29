const $ = (id) => document.getElementById(id);

function show(status) {
  const state = $("state");
  state.className = "state";
  $("claude").hidden = true;
  if (!status) {
    state.lastElementChild.textContent = "No reading yet.";
    return;
  }
  if (status.sent) {
    state.classList.add("ok");
    state.lastElementChild.innerHTML = "";
    state.lastElementChild.append("Sending usage for ", Object.assign(document.createElement("strong"), { textContent: status.email ?? "this Claude account" }));
    $("detail").textContent = "Updates every 3 minutes while this browser is open.";
  } else if (status.signedOut) {
    state.classList.add("bad");
    state.lastElementChild.textContent = "Not signed in to Claude in this browser profile.";
    $("detail").textContent = "Sign in at claude.ai and this account will appear on the dashboard.";
    $("claude").hidden = false;
  } else {
    state.classList.add("bad");
    state.lastElementChild.textContent = "Could not send usage.";
    $("detail").textContent = /^Dashboard/.test(status.error ?? "")
      ? "The AI Meter app does not seem to be running on this computer."
      : status.error;
  }
}

chrome.storage.local.get("status").then(({ status }) => show(status));
chrome.runtime.sendMessage("read-now").then(show).catch(() => {});
