// =====================================
// Coach Overlay App - app.js (Full Rewrite)
// - OCR reads HUD signals (HP/reload/storm/etc)
// - Outputs REAL tips from tip banks (never repeats OCR text)
// - Vercel API enabled: /api/game-settings
//
// Requires in index.html ABOVE app.js:
// <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
//
// Expected HTML IDs:
// status, captureStatus, currentTip, tipHistory
// screenPreview (video), captureCanvas (canvas)
// gameMode (select), customGame (input)
//
// Buttons call:
// startScreenShare(), stopScreenShare()
// startCoaching(), stopCoaching()
// simulateTip(), resetTipHistory()
// setGameMode(this.value), setCustomGame(this.value)
// =====================================

// ---------- SETTINGS ----------
const FRAME_CAPTURE_INTERVAL_MS = 2000;
const SCALE = 0.5;
const UPSCALE = 3;
const TIP_COOLDOWN_MS = 3500;     // shorter is more responsive
const SPEAK_TIPS = true;

// Crop size (bottom corners)
let HUD_KEEP_W = 0.50;
let HUD_KEEP_H = 0.45;

// ---------- TIP BANKS (REAL TIPS) ----------
const TIP_BANK = {
  fortnite: {
    lowHp: [
      "Heal ASAP, then reposition. Don’t re-peek while weak.",
      "Play cover first—box up or use natural cover before healing.",
      "If you’re low, disengage and reset instead of forcing it."
    ],
    criticalHp: [
      "CRITICAL HP—hard cover NOW, then heal immediately.",
      "You’re one-shot. Break line-of-sight, then heal."
    ],
    reload: [
      "Reload behind cover—don’t wide peek while reloading.",
      "Weapon swap is faster than reloading. Use your inventory order."
    ],
    storm: [
      "Check map + rotate early. Don’t get stuck running from storm.",
      "Use storm edge to reduce angles enemies can shoot from."
    ],
    eliminated: [
      "Reset: next fight, use cover longer and don’t over-peek.",
      "Think: positioning, timing, or tunnel vision—fix one thing next round."
    ],
    win: [
      "Nice. Repeat what worked: cover + timing + smart rotates.",
      "Good game—keep your inventory order consistent for faster swaps."
    ],
    general: [
      "Turn on Visualize Sound Effects. Huge awareness advantage.",
      "Prioritize high ground in fights. Better angles, harder to hit you.",
      "Keep moving—even while looting/healing. Don’t be a free snipe.",
      "Carry heals + mobility. Use shields when you find them."
    ]
  },

  genericShooter: {
    lowHp: [
      "Low health—stop wide peeking. Heal behind cover first.",
      "Break line-of-sight, then heal. Don’t ego-challenge on low HP."
    ],
    criticalHp: [
      "CRITICAL—hard cover NOW. Reset the fight and heal.",
      "One-shot danger. Disengage and heal immediately."
    ],
    reload: [
      "Reload behind cover, not in the open.",
      "Swap weapons instead of reloading in a close fight."
    ],
    eliminated: [
      "Eliminated—review: were you exposed too long or fighting without cover?",
      "Next fight: pre-aim common angles and use cover discipline."
    ],
    win: [
      "Nice. Keep the same good habits: cover, timing, and repositioning."
    ],
    general: [
      "Don’t stand still—strafe and reposition between shots.",
      "Take fights with cover. Minimize how much of you is visible."
    ]
  }
};

function pickTip(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// ---------- STATE ----------
let isCoaching = false;
let screenStream = null;
let autoCaptureIntervalId = null;

let tipHistory = [];
let ocrBusy = false;
let lastSeenText = "";
let lastTipTime = 0;
let lastTipKey = ""; // prevents spam of same “type” tip

// Game mode state
let gameMode = localStorage.getItem("gameMode") || "fortnite"; // fortnite | valorant | cod | custom
let customGame = localStorage.getItem("customGame") || "";

// ---------- STORAGE ----------
function saveHistory() {
  localStorage.setItem("tipHistory", JSON.stringify(tipHistory));
}
function loadHistory() {
  const saved = localStorage.getItem("tipHistory");
  if (!saved) return;
  try { tipHistory = JSON.parse(saved) || []; }
  catch { tipHistory = []; }
}

// ---------- UI ----------
function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.innerText = text;
}
function setCaptureStatus(text) {
  const el = document.getElementById("captureStatus");
  if (el) el.innerText = text;
}
function setCurrentTip(text) {
  const el = document.getElementById("currentTip");
  if (el) el.innerText = text;
}
function renderHistory() {
  const ul = document.getElementById("tipHistory");
  if (!ul) return;

  ul.innerHTML = "";
  for (let i = 0; i < tipHistory.length; i++) {
    const li = document.createElement("li");

    const text = document.createElement("span");
    text.innerText = tipHistory[i];

    const trash = document.createElement("span");
    trash.innerText = " 🗑";
    trash.style.cursor = "pointer";
    trash.style.marginLeft = "10px";
    trash.style.color = "#999";
    trash.onclick = () => {
      tipHistory.splice(i, 1);
      saveHistory();
      renderHistory();
    };

    li.appendChild(text);
    li.appendChild(trash);
    ul.appendChild(li);
  }
}
function renderAll() {
  setStatus(isCoaching ? "Status: Coaching ON" : "Status: Not running");
  renderHistory();
}

// ---------- SPEECH ----------
function speakTip(text) {
  if (!SPEAK_TIPS) return;
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

// ---------- TIPS ----------
function addTip(text, opts = {}) {
  const force = Boolean(opts.force);
  const now = Date.now();
  if (!force && now - lastTipTime < TIP_COOLDOWN_MS) return;
  lastTipTime = now;

  setCurrentTip(text);
  tipHistory.push(text);
  saveHistory();
  renderHistory();
  speakTip(text);
}

function addTipOnceByKey(key, text) {
  if (key === lastTipKey) return;
  lastTipKey = key;
  addTip(text);
}

function resetTipHistory() {
  if (!confirm("Delete all tips?")) return;
  tipHistory = [];
  saveHistory();
  setCurrentTip("No tip yet.");
  renderHistory();
}

function simulateTip() {
  captureFrameAndOCR(true);
}

// ---------- GAME MODE ----------
function labelForMode(mode) {
  if (mode === "fortnite") return "FORTNITE";
  if (mode === "cod") return "CALL OF DUTY";
  if (mode === "valorant") return "VALORANT";
  return "CUSTOM";
}

function applyModeSettings(mode) {
  HUD_KEEP_W = 0.50;
  HUD_KEEP_H = 0.45;

  if (mode !== "custom") localStorage.removeItem("customPreferSide");
}

function setGameMode(mode) {
  gameMode = mode;
  localStorage.setItem("gameMode", mode);
  applyModeSettings(mode);
  addTip(`Game mode set to: ${labelForMode(mode)}`, { force: true });
}

// Debounce backend lookups while typing
let lookupTimer = null;

function setCustomGame(name) {
  customGame = name;
  localStorage.setItem("customGame", name);

  const typed = name.trim().toLowerCase();
  const sel = document.getElementById("gameMode");
  if (!typed) return;

  // Presets:
  if (typed.includes("fortnite") || typed === "fn") gameMode = "fortnite";
  else if (typed.includes("valorant") || typed.includes("valo")) gameMode = "valorant";
  else if (
    typed.includes("call of duty") ||
    typed.includes("cod") ||
    typed.includes("warzone") ||
    typed.includes("modern warfare")
  ) gameMode = "cod";
  else gameMode = "custom";

  localStorage.setItem("gameMode", gameMode);
  if (sel) sel.value = gameMode;

  applyModeSettings(gameMode);

  if (gameMode !== "custom") {
    addTip(`Auto-detected: ${labelForMode(gameMode)}`, { force: true });
    return;
  }

  addTip(`Custom game: ${name} (looking up settings…)`, { force: true });

  if (lookupTimer) clearTimeout(lookupTimer);
  lookupTimer = setTimeout(() => {
    tryLoadUnknownGameSettingsFromBackend(name);
  }, 500);
}

// ✅ API lookup (your Vercel backend)
async function tryLoadUnknownGameSettingsFromBackend(gameName) {
  try {
    const url = `${location.origin}/api/game-settings?name=${encodeURIComponent(gameName)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      addTip("Game settings API error.", { force: true });
      return;
    }
    const data = await res.json();

    if (typeof data.keepW === "number") HUD_KEEP_W = data.keepW;
    if (typeof data.keepH === "number") HUD_KEEP_H = data.keepH;

    if (data.preferSide === "right" || data.preferSide === "left") {
      localStorage.setItem("customPreferSide", data.preferSide);
      addTip(`Auto-configured: prefer ${data.preferSide.toUpperCase()} HUD`, { force: true });
    } else {
      addTip("Auto-configured (no side preference).", { force: true });
    }
  } catch (e) {
    console.log(e);
    addTip("Could not reach game settings API.", { force: true });
  }
}

// ---------- SCREEN SHARE ----------
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.getElementById("screenPreview");
    if (video) video.srcObject = screenStream;

    const track = screenStream.getVideoTracks()[0];
    if (track) track.addEventListener("ended", stopScreenShare);

    setCaptureStatus("Stream connected. Waiting for video...");
  } catch {
    alert("Screen share cancelled.");
  }
}

function stopScreenShare() {
  if (!screenStream) return;

  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  const video = document.getElementById("screenPreview");
  if (video) video.srcObject = null;

  setCaptureStatus("Stopped sharing.");
}

// ---------- COACHING ----------
function startCoaching() {
  isCoaching = true;
  renderAll();
  startAutoCapture();
}
function stopCoaching() {
  isCoaching = false;
  renderAll();
  stopAutoCapture();
}

// ---------- CAPTURE ----------
function captureFrameAndOCR(isManual) {
  const video = document.getElementById("screenPreview");
  if (!video) return setCaptureStatus("Error: screenPreview not found.");
  if (!video.srcObject) return setCaptureStatus("Click Share Screen first.");
  if (!video.videoWidth || !video.videoHeight) return setCaptureStatus("Waiting for video...");

  const canvas = document.getElementById("captureCanvas");
  if (!canvas) return setCaptureStatus("Error: captureCanvas not found.");

  canvas.width = Math.floor(video.videoWidth * SCALE);
  canvas.height = Math.floor(video.videoHeight * SCALE);

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, canvas.width, canvas.height);

  setCaptureStatus("Captured at " + new Date().toLocaleTimeString());
  runOCRFromCanvas(canvas, isManual);
}

// ---------- SIGNAL DETECTION ----------
function getHealthFromText(rawText) {
  const t = (rawText || "").toUpperCase().replace(/\s+/g, " ");

  const patterns = [
    /HP\s*[:\-]?\s*(\d{1,3})/,
    /HEALTH\s*[:\-]?\s*(\d{1,3})/,
    /(\d{1,3})\s*HP/,
    /(\d{1,3})\s*HEALTH/
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 300) return n;
    }
  }

  // fallback: any number
  const onlyNumber = t.match(/\b(\d{1,3})\b/);
  if (onlyNumber) {
    const n = parseInt(onlyNumber[1], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 300) return n;
  }

  return null;
}

function detectSignals(textRaw) {
  const t = (textRaw || "").toUpperCase();

  const hp = getHealthFromText(t);
  const criticalHp = hp !== null && hp <= 25;
  const lowHp = hp !== null && hp <= 50;

  const reload = /RELOAD|OUT OF AMMO|NO AMMO|AMMO/.test(t);
  const storm = /STORM|CIRCLE|SAFE ZONE|ZONE/.test(t);
  const eliminated = /ELIMINATED|YOU DIED|DEFEAT/.test(t);
  const win = /VICTORY|WIN/.test(t);

  return { hp, criticalHp, lowHp, reload, storm, eliminated, win };
}

function chooseTipFromSignals(signals) {
  // Choose bank based on game mode
  const bank = (gameMode === "fortnite") ? TIP_BANK.fortnite : TIP_BANK.genericShooter;

  // Priority order
  if (signals.criticalHp) return { key: "criticalHp", text: pickTip(bank.criticalHp) };
  if (signals.lowHp) return { key: "lowHp", text: pickTip(bank.lowHp) };
  if (signals.reload) return { key: "reload", text: pickTip(bank.reload) };
  if (signals.storm && bank.storm) return { key: "storm", text: pickTip(bank.storm) };
  if (signals.eliminated) return { key: "eliminated", text: pickTip(bank.eliminated) };
  if (signals.win) return { key: "win", text: pickTip(bank.win) };

  // Sometimes a general tip (not too spammy)
  if (Math.random() < 0.12 && bank.general) return { key: "general", text: pickTip(bank.general) };

  return null;
}

// ---------- OCR ----------
async function runOCRFromCanvas(canvas, isManual) {
  if (typeof Tesseract === "undefined") {
    if (isManual) addTip("OCR library not loaded. Check index.html script tags.", { force: true });
    return;
  }
  if (ocrBusy) return;
  ocrBusy = true;

  try {
    const rightCrop = cropBottomRight(canvas, HUD_KEEP_W, HUD_KEEP_H);
    const leftCrop = cropBottomLeft(canvas, HUD_KEEP_W, HUD_KEEP_H);

    const rightPrepped = prepForOCR(rightCrop);
    const leftPrepped = prepForOCR(leftCrop);

    const rightText = await ocrCanvas(rightPrepped);
    const leftText = await ocrCanvas(leftPrepped);

    const chosenRaw = chooseTextByMode(rightText, leftText);
    const textRaw = (chosenRaw || "").toUpperCase().trim();

    if (textRaw.length < 3) {
      if (isManual) addTip("No clear HUD text detected yet.", { force: true });
      return;
    }

    // Stop repeating identical OCR results in auto mode
    if (!isManual && textRaw === lastSeenText) return;
    lastSeenText = textRaw;

    // ✅ Convert OCR -> signals -> REAL tip
    const signals = detectSignals(textRaw);
    const chosen = chooseTipFromSignals(signals);

    if (chosen) {
      addTipOnceByKey(chosen.key, chosen.text);
    } else if (isManual) {
      addTip("No real HUD signal yet—try showing HP / Reload / Storm / Eliminated.", { force: true });
    }

  } catch (e) {
    console.error("OCR error:", e);
    if (isManual) addTip("OCR error. Check console.", { force: true });
  } finally {
    ocrBusy = false;
  }
}

// ---------- OCR HELPERS ----------
async function ocrCanvas(c) {
  const result = await Tesseract.recognize(c, "eng", { tessedit_pageseg_mode: 6 });
  return (result.data.text || "").trim();
}

function prepForOCR(sourceCanvas) {
  const up = upscaleCanvas(sourceCanvas, UPSCALE);
  return boostContrast(up);
}

function scoreOCRText(t) {
  const s = (t || "").toUpperCase();
  const matches = s.match(/[A-Z0-9]/g);
  return matches ? matches.length : 0;
}

function chooseTextByMode(rightText, leftText) {
  const rScore = scoreOCRText(rightText);
  const lScore = scoreOCRText(leftText);

  if (gameMode === "fortnite") return rScore > 0 ? rightText : leftText;
  if (gameMode === "valorant" || gameMode === "cod") return lScore > 0 ? leftText : rightText;

  // custom: use backend preference if present
  const prefer = localStorage.getItem("customPreferSide");
  if (prefer === "right") return rScore > 0 ? rightText : leftText;
  if (prefer === "left") return lScore > 0 ? leftText : rightText;

  return rScore >= lScore ? rightText : leftText;
}

// ---------- CROPPING ----------
function cropBottomLeft(sourceCanvas, keepW = 0.45, keepH = 0.45) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;

  const cropW = Math.floor(w * keepW);
  const cropH = Math.floor(h * keepH);

  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;

  out.getContext("2d").drawImage(
    sourceCanvas,
    0, h - cropH, cropW, cropH,
    0, 0, cropW, cropH
  );

  return out;
}

function cropBottomRight(sourceCanvas, keepW = 0.45, keepH = 0.45) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;

  const cropW = Math.floor(w * keepW);
  const cropH = Math.floor(h * keepH);

  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;

  out.getContext("2d").drawImage(
    sourceCanvas,
    w - cropW, h - cropH, cropW, cropH,
    0, 0, cropW, cropH
  );

  return out;
}

// ---------- IMAGE PROCESSING ----------
function upscaleCanvas(sourceCanvas, scale) {
  const out = document.createElement("canvas");
  out.width = sourceCanvas.width * scale;
  out.height = sourceCanvas.height * scale;

  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0, out.width, out.height);

  return out;
}

function boostContrast(sourceCanvas) {
  const out = document.createElement("canvas");
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;

  const ctx = out.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let gray = (r + g + b) / 3;

    // contrast boost
    gray = (gray - 128) * 1.6 + 128;
    gray = Math.max(0, Math.min(255, gray));

    d[i] = d[i + 1] = d[i + 2] = gray;
  }

  ctx.putImageData(img, 0, 0);
  return out;
}

// ---------- AUTO CAPTURE ----------
function startAutoCapture() {
  if (autoCaptureIntervalId !== null) return;

  autoCaptureIntervalId = setInterval(() => {
    if (!isCoaching) return;
    captureFrameAndOCR(false);
  }, FRAME_CAPTURE_INTERVAL_MS);
}

function stopAutoCapture() {
  if (autoCaptureIntervalId === null) return;
  clearInterval(autoCaptureIntervalId);
  autoCaptureIntervalId = null;
}

// ---------- INIT ----------
loadHistory();
renderAll();

const modeSelect = document.getElementById("gameMode");
if (modeSelect) modeSelect.value = gameMode;

const customInput = document.getElementById("customGame");
if (customInput) customInput.value = customGame;

applyModeSettings(gameMode);
