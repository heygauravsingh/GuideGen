const toggle = document.getElementById("toggle");
const toggleLabel = document.getElementById("toggleLabel");
const toggleIcon = document.getElementById("toggleIcon");
const library = document.getElementById("library");
const statusTitle = document.getElementById("statusTitle");
const statusSub = document.getElementById("statusSub");
const hint = document.getElementById("hint");

const DOT = '<circle cx="12" cy="12" r="7" />';
const SQUARE = '<rect x="6" y="6" width="12" height="12" rx="2.5" />';

function render(state) {
  const rec = state && state.recording;
  const n = (state && state.stepCount) || 0;
  document.body.classList.toggle("rec", !!rec);
  if (rec) {
    toggleLabel.textContent = "Stop & edit";
    toggleIcon.innerHTML = SQUARE;
    statusTitle.textContent = "Recording…";
    statusSub.textContent = n === 1 ? "1 step captured" : n + " steps captured";
    hint.textContent = "Do your workflow as normal, then stop to edit the guide.";
  } else {
    toggleLabel.textContent = "Start recording";
    toggleIcon.innerHTML = DOT;
    statusTitle.textContent = "Ready to record";
    statusSub.textContent = "Every click becomes a step";
    hint.textContent =
      "Tip: if a tab was open before you installed FlowScribe, reload it once before recording.";
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "fs_get_state" }, (s) => {
    if (chrome.runtime.lastError) return;
    render(s || { recording: false });
  });
}

toggle.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fs_get_state" }, (s) => {
    if (s && s.recording) {
      chrome.runtime.sendMessage({ type: "fs_stop" }, (resp) => {
        if (resp && resp.guideId)
          chrome.runtime.sendMessage({ type: "fs_open_editor", guideId: resp.guideId });
        window.close();
      });
    } else {
      chrome.runtime.sendMessage({ type: "fs_start" }, () => window.close());
    }
  });
});

library.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fs_open_editor" }, () => window.close());
});

refresh();
