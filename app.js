import { auth, db, MASTER_GOD_UID } from "./firebase-config.js";
import { cloudName as CLOUDINARY_CLOUD_NAME, uploadPreset as CLOUDINARY_UPLOAD_PRESET } from "./cloudinary-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, updateProfile, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, getDocs, collection, query, where,
  updateDoc, deleteDoc, onSnapshot, addDoc, serverTimestamp, writeBatch, orderBy, limit, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// The AI model that turns a photo into a vector, running fully in the
// browser — no server involved. First use downloads the model and the
// browser caches it after that.
// Build stamp: index.html carries the same one. If they differ, the page shows a warning
// (it means only one of the two files was replaced on GitHub).
const BUILD = "ai-pro-v17";
window.__APP_BUILD = BUILD;
function friendlyAuthError(err) {
  const code = String(err?.code || "");
  const map = {
    "auth/invalid-credential": "Email or password is wrong.",
    "auth/invalid-login-credentials": "Email or password is wrong.",
    "auth/wrong-password": "Email or password is wrong.",
    "auth/user-not-found": "Email or password is wrong.",
    "auth/invalid-email": "That email address is not valid.",
    "auth/user-disabled": "This account has been disabled.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "Cannot reach Google. Check the internet connection and try again.",
    "auth/unauthorized-domain": "This website address is not allowed in Firebase. Add it in Firebase → Authentication → Settings → Authorized domains.",
    "auth/operation-not-allowed": "Email/password sign-in is switched off. Turn it on in Firebase → Authentication → Sign-in method.",
    "auth/invalid-api-key": "The Firebase API key in firebase-config.js is wrong.",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "The Firebase API key in firebase-config.js is wrong.",
    "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
    "auth/weak-password": "Password is too weak. Use at least 6 characters.",
    "permission-denied": "Not allowed yet — the Master must publish the newest Firestore rules (firestore.rules) in Firebase.",
  };
  return map[code] || ((err && err.message) || "Something went wrong") + (code ? ` (${code})` : "");
}
const onId = (id, evt, fn, opts) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn, opts); };

// Loaded on demand (it is a big library) so the page itself starts fast.
let _pipelineFn = null;
async function loadPipeline() {
  if (!_pipelineFn) _pipelineFn = (await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2")).pipeline;
  return _pipelineFn;
}

// ============================================================
// The fixed Business SOT operation list — every SOT card uses
// exactly these rows (blank means "not used" for that article).
// ============================================================
const CORE_OPERATIONS = [
  "Lamination", "Cutting", "Crimping", "Skiving", "UV-marking", "Embossed/Heat-seal",
  "Seamless", "Printing", "Fusing", "Loop Cutting", "Heat press", "Heat Cut", "Brush",
  "Edge color/Spray", "Bootie", "Pattern Sewing", "Embroidery", "Stitching", "UV Treatment",
  "Buffing", "Stock Fitting", "Socks Preparation", "Footbed Preparation", "Insole Preparation",
  "Sole Stitch/Preparation", "Cemented/DIP", "Packing",
];
// More operations used in the SOT Master File — shown in the Add form via "Add operation".
const EXTRA_OPERATIONS = [
  "Elastic Press", "Upper Deco Stitch", "Foil Stamping", "Preparation", "UV Marking & Printing", "Marking",
  "Edge Burn", "WP Gluing", "Gasket", "Belt Folding", "Sewing Preparation", "Pre Stitching", "Sole Paint",
  "Insole", "Socks Stitching", "Insole & Heel Preparation", "Outsole Bend", "Sole Buffing", "Welt Attachment",
  "Espadrilles Preparation", "Assembly", "Hand Stitch", "Others",
];
const BUSINESS_SOT_OPERATIONS = [...CORE_OPERATIONS, ...EXTRA_OPERATIONS];

// Optional Gemini "AI check". The API key is NOT in this public code: it lives in the Firestore
// document config/gemini ({ apiKey, model }) which only approved, signed-in users can read.
// Without that document the app simply works with visual similarity only.
let geminiCfg = null;
const geminiReady = () => !!(geminiCfg && geminiCfg.geminiApiKey);
async function loadGeminiConfig() {
  try {
    const snap = await getDoc(doc(db, "config", "gemini"));
    if (snap.exists() && snap.data().apiKey) {
      geminiCfg = { geminiApiKey: String(snap.data().apiKey).trim(), geminiModel: snap.data().model || "gemini-3.1-flash-lite" };
    }
  } catch (_) { /* no config / no access — AI check stays off */ }
}

let embedder = null;
async function getEmbedder() {
  if (!embedder) { const pipeline = await loadPipeline(); embedder = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32"); }
  return embedder;
}
async function embedImage(fileOrUrl) {
  const model = await getEmbedder();
  const output = await model(fileOrUrl, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
function cosineSimilarity(a, b) {
  // CLIP embeddings are NOT unit length, so divide by both lengths.
  // Result is between -1 and 1 (1 = identical look); never above 100%.
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0; // entry without a photo
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// How to read a score: CLIP photo-vs-photo scores of unrelated shoes still sit around 50-65%,
// so only the higher bands mean "looks alike". Adjust these cut-offs if needed.
// Raw CLIP cosine of two shoe photos is ~0.60-0.75 even when they are different shoes,
// so we stretch 0.60..0.95 onto 0..100% before showing it.
function matchPct(cos) { return Math.round(Math.min(1, Math.max(0, (cos - 0.60) / 0.35)) * 100); }
function matchBand(score) {
  const p = matchPct(score);
  if (p >= 75) return { cls: "strong", label: "Strong match" };
  if (p >= 50) return { cls: "possible", label: "Possible match" };
  return { cls: "weak", label: "Weak match" };
}
// When the AI has judged a candidate, its verdict replaces the visual score.
function aiBadge(ai) {
  if (ai.verdict === "same") return { cls: "strong", label: "AI: same construction" };
  if (ai.verdict === "similar") return { cls: "possible", label: "AI: close, sole differs" };
  if (ai.verdict === "related") return { cls: "weak", label: "Same family, different style" };
  return { cls: "weak", label: "AI: different shoe" };
}

// ============================================================
// Roles
// ============================================================
let currentUser = null;
let currentProfile = null;
function canManageUsers(role) { return role === "master" || role === "master_god"; }
function canUpload(role) { return role === "editor" || role === "master" || role === "master_god"; }

// ============================================================
// Screens
// ============================================================
const screens = {
  login: document.getElementById("screen-login"),
  pending: document.getElementById("screen-pending"),
  app: document.getElementById("screen-app"),
};
function showScreen(name) { Object.entries(screens).forEach(([k, el]) => (el.hidden = k !== name)); }

onId("show-signup", "click", () => {
  document.getElementById("form-login").hidden = true;
  document.getElementById("show-signup").hidden = true;
  document.getElementById("form-signup").hidden = false;
});
onId("show-login", "click", () => {
  document.getElementById("form-signup").hidden = true;
  document.getElementById("form-login").hidden = false;
  document.getElementById("show-signup").hidden = false;
});

onId("form-signup", "submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const errorBox = document.getElementById("signup-error");
  errorBox.hidden = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: name });
    const isFirstEverUser = cred.user.uid === MASTER_GOD_UID;
    await setDoc(doc(db, "users", cred.user.uid), {
      name, email,
      role: isFirstEverUser ? "master_god" : "viewer",
      approved: isFirstEverUser,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    errorBox.textContent = friendlyAuthError(err);
    errorBox.hidden = false;
  }
});

onId("form-login", "submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorBox = document.getElementById("login-error");
  errorBox.hidden = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorBox.textContent = friendlyAuthError(err);
    errorBox.hidden = false;
  }
});
// ---- Forgot password: (A) reset link by email, (B) ask the Master (for dummy / shared emails) ----
let forgotMode = "a";
function setForgotMode(m) {
  forgotMode = m;
  document.getElementById("fg-mode-a").classList.toggle("on", m === "a");
  document.getElementById("fg-mode-b").classList.toggle("on", m === "b");
  document.getElementById("fg-extra").hidden = m !== "b";
  document.getElementById("fg-help").textContent = m === "a"
    ? "Use this if your login email is a real inbox you can open. We send a reset link to it."
    : "Use this if your login email is a dummy or someone else's inbox. Tell the Master who you are — he will reset your access and contact you.";
  document.getElementById("forgot-submit").textContent = m === "a" ? "Send reset link" : "Ask Master to reset";
  document.getElementById("forgot-email").placeholder = "the email you sign in with";
  document.getElementById("forgot-msg").hidden = true;
}
function showForgot(on) {
  document.getElementById("form-login").hidden = on;
  document.getElementById("show-signup").hidden = on;
  const sf = document.getElementById("show-forgot"); if (sf) sf.hidden = on;
  document.getElementById("panel-forgot").hidden = !on;
  if (on) { setForgotMode("a"); document.getElementById("forgot-email").value = document.getElementById("login-email").value; }
}
onId("show-forgot", "click", () => showForgot(true));
onId("forgot-back", "click", () => showForgot(false));
onId("fg-mode-a", "click", () => setForgotMode("a"));
onId("fg-mode-b", "click", () => setForgotMode("b"));
onId("form-forgot", "submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("forgot-email").value.trim();
  const msg = document.getElementById("forgot-msg");
  const btn = document.getElementById("forgot-submit");
  const say = (t, ok) => { msg.textContent = t; msg.className = ok ? "ok-text" : "error-text"; msg.hidden = false; };
  btn.disabled = true;
  try {
    if (forgotMode === "a") {
      await sendPasswordResetEmail(auth, email);
      say("If this email has an account, a reset link is on its way. Check the Spam folder too.", true);
    } else {
      const name = document.getElementById("forgot-name").value.trim();
      const note = document.getElementById("forgot-note").value.trim();
      if (!name) throw new Error("Please type your name so the Master knows who you are.");
      await addDoc(collection(db, "resetRequests"), { name, email, note, status: "open", createdAt: serverTimestamp() });
      say("Request sent. The Master will reset your access and contact you.", true);
    }
  } catch (err) { say(friendlyAuthError(err), false); }
  btn.disabled = false;
});
onId("signout-btn", "click", () => signOut(auth));
onId("pending-signout", "click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) { showScreen("login"); return; }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    currentProfile = snap.exists() ? snap.data() : null;
  } catch (err) {
    // signed in, but the profile could not be read (usually Firestore rules or network)
    showScreen("login");
    const eb = document.getElementById("login-error");
    if (eb) { eb.textContent = "Signed in, but your profile could not be loaded: " + (err.code || err.message) + ". Check the Firestore rules in Firebase."; eb.hidden = false; }
    signOut(auth).catch(() => {});
    return;
  }
  if (!currentProfile || !currentProfile.approved) { showScreen("pending"); return; }
  showScreen("app");
  getAllLatestSots().catch(() => {});
  loadGeminiConfig();
  applyRoleToUI(currentProfile.role);
  prewarmModel();
  document.getElementById("user-name").textContent = currentProfile.name || user.email;
  document.getElementById("user-role").textContent = currentProfile.role.replace("_", " ");
  if (canManageUsers(currentProfile.role)) { watchUsers(); watchResetRequests(); }
});

// ---- Dark mode (remembered in this browser) + "/" shortcut ----
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  const b = document.getElementById("theme-btn");
  if (b) b.textContent = t === "dark" ? "Light mode" : "Dark mode";
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("sot-theme"); } catch (_) {}
  if (!t) t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(t);
  onId("theme-btn", "click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("sot-theme", next); } catch (_) {}
  });
})();
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (["input", "textarea", "select"].includes(tag) || e.target.isContentEditable) return;
  if (document.getElementById("screen-app").hidden) return;
  e.preventDefault();
  document.querySelector('.nav-item[data-tab="tab-search"]').click();
  document.getElementById("article-input").focus();
});

// Warm up the AI model in the background so the first image match is quick.
function prewarmModel() { (window.requestIdleCallback || ((f) => setTimeout(f, 2500)))(() => { getEmbedder().catch(() => {}); }); }

function applyRoleToUI(role) {
  document.getElementById("nav-upload").hidden = !canUpload(role);
  document.getElementById("nav-import").hidden = !canUpload(role);
  document.getElementById("nav-users").hidden = !canManageUsers(role);
  const na = document.getElementById("nav-activity"); if (na) na.hidden = !canManageUsers(role);
  const nq = document.getElementById("nav-quality"); if (nq) nq.hidden = !canUpload(role);
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    // pick up other people's changes: drop a cache older than 20 seconds when opening a list tab
    if (["tab-master", "tab-search", "tab-match", "tab-quality"].includes(btn.dataset.tab) && Date.now() - sotCacheAt > 20000) sotCache = null;
    if (btn.dataset.tab === "tab-quality") renderQuality().catch(() => {});
    if (btn.dataset.tab === "tab-master") renderMaster().catch(() => {});
    if (btn.dataset.tab === "tab-activity") renderActivity();
    if (btn.dataset.tab === "tab-upload" && (editingId || matchFlow || document.getElementById("add-mode-banner").style.display === "block")) {
      exitEditMode();
      document.getElementById("form-add-sot").reset();
      resetSotTable();
    }
  });
});

// ============================================================
// Shared helpers: build a SOT object from form-like inputs,
// save with versioning, render result cards, open detail modal
// ============================================================
function totalMinutes(obj) { return Object.values(obj || {}).reduce((s, v) => s + Number(v || 0), 0); }

async function uploadToCloudinary(fileOrDataUrl) {
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const formData = new FormData();
  formData.append("file", fileOrDataUrl);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(url, { method: "POST", body: formData });
  const data = await res.json();
  if (!data.secure_url) throw new Error("Cloudinary upload failed");
  return data.secure_url;
}

// Saves a SOT, handling the "same article again" versioning rule:
// the previous latest doc for that article (if any) is marked
// isLatest:false, and this one is saved as the new isLatest:true.
async function saveSotWithVersioning(sotData) {
  const existingQ = query(collection(db, "sots"), where("article", "==", sotData.article), where("isLatest", "==", true));
  const existingSnap = await getDocs(existingQ);
  const isNewVersion = !existingSnap.empty;
  for (const d of existingSnap.docs) {
    await updateDoc(doc(db, "sots", d.id), { isLatest: false });
  }
  await addDoc(collection(db, "sots"), {
    ...sotData,
    isLatest: true,
    year: new Date().getFullYear(),
    addedBy: currentUser.uid,
    createdAt: serverTimestamp(),
  });
  invalidateSotCache();
  return isNewVersion;
}

let matchFlow = false; // true when the opened card came from an image-match search
function renderResults(container, items, showScore) {
  container.innerHTML = "";
  if (items.length === 0) { container.hidden = true; return; }
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <img src="${item.photoUrl || ""}" alt="${esc(item.construction?.Construction || "")}" />
      <div class="result-card-body">
        <span class="result-article">${item.article || "—"}</span>${item.incomplete ? ' <span class="inc-badge" title="This SOT was saved as incomplete">Incomplete</span>' : ""}
        <p class="result-name">${esc(item.construction?.Construction || item.costing?.["Types of Shoe"] || "Untitled")}</p>
        <p class="result-material">${esc([item.costing?.Customer, item.costing?.Brand, item.costing?.["Types of Shoe"]].filter(Boolean).join(" · ") || item.construction?.Outsole || "")}</p>
        ${totalMinutes(item.businessSOT) > 0 ? `<p class="result-sot">SOT ${totalMinutes(item.businessSOT).toFixed(1)} min</p>` : ""}
        ${item.ai ? `<p class="ai-line ai-${esc(item.ai.verdict)}"><strong>AI: ${esc(item.ai.verdict)}${item.ai.score != null ? ` · ${Math.round(item.ai.score)}/100` : ""}</strong><br>${esc(item.ai.reason)}</p>${item.ai.checks ? `<p class="checks">${[["type", "Type"], ["heel", "Heel"], ["style", "Style"], ["sole", "Sole"]].map(([k, l]) => `<span class="chk ${item.ai.checks[k] ? "yes" : "no"}">${item.ai.checks[k] ? "✓" : "✗"} ${l}</span>`).join("")}</p>` : ""}` : ""}
        ${showScore ? (item.ai
          ? `<span class="result-score score-${aiBadge(item.ai).cls}">${aiBadge(item.ai).label}</span>`
          : `<span class="result-score score-${matchBand(item.score).cls}">Visual ${matchPct(item.score)}% · ${matchBand(item.score).label}</span>`) : ""}
      </div>`;
    card.addEventListener("click", () => { matchFlow = !!showScore; openModal(item); });
    container.appendChild(card);
  });
  container.hidden = false;
}

// ============================================================
// Latest-version cache + buyer filter (shared by both search tabs)
// ============================================================
let sotCache = null, sotCacheAt = 0;
function invalidateSotCache() {
  sotCache = null;
  // Refresh whatever list is on screen so a save/update shows up without reloading the page.
  setTimeout(() => {
    const active = document.querySelector(".tab.active")?.id;
    if (active === "tab-master") renderMaster().catch(() => {});
    else if (active === "tab-quality") renderQuality().catch(() => {});
    else if (active === "tab-search") runArticleSearch().catch(() => {});
    else getAllLatestSots().catch(() => {});
  }, 300);
}
async function getAllLatestSots() {
  if (!sotCache || Date.now() - sotCacheAt > 60000) {
    const snap = await getDocs(query(collection(db, "sots"), where("isLatest", "==", true)));
    const list = [];
    snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
    sotCache = list; sotCacheAt = Date.now();
    renderBuyerFilters();
  }
  return sotCache;
}

// ---- Audit log + recycle bin helpers ----
async function logAudit(action, article, detail = "") {
  try {
    await addDoc(collection(db, "auditLog"), {
      at: serverTimestamp(), uid: currentUser.uid, name: currentProfile?.name || currentUser.email || "",
      action, article: article || "", detail: String(detail || "").slice(0, 300),
    });
  } catch (_) { /* logging is best-effort */ }
}
async function getAllSotDocs() { // every version, not just the latest
  const snap = await getDocs(collection(db, "sots"));
  const list = []; snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
  return list;
}
// Moves SOT docs to the recycle bin (kept 30 days), 200 at a time.
async function moveToTrash(docs) {
  const who = currentProfile?.name || currentUser.email || "";
  const entries = []; // kept in memory so the delete can be undone
  for (let i = 0; i < docs.length; i += 200) {
    const b = writeBatch(db);
    docs.slice(i, i + 200).forEach((d) => {
      const { id, ...data } = d;
      const ref = doc(collection(db, "trash"));
      entries.push({ tid: ref.id, id, data });
      b.set(ref, { ...data, origId: id, deletedAt: serverTimestamp(), deletedBy: who });
      b.delete(doc(db, "sots", id));
    });
    await b.commit();
  }
  return entries;
}
// After deleting, every article that still has versions must have exactly one latest.
// Returns the ids that were promoted to "latest" (needed to undo).
async function fixLatestFlags(remaining, articles) {
  const byArticle = new Map();
  remaining.forEach((d) => { if (articles.has(d.article)) { if (!byArticle.has(d.article)) byArticle.set(d.article, []); byArticle.get(d.article).push(d); } });
  const b = writeBatch(db); const promoted = [];
  byArticle.forEach((list) => {
    if (list.some((d) => d.isLatest)) return;
    list.sort((a, b2) => (b2.year || 0) - (a.year || 0) || (b2.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    b.update(doc(db, "sots", list[0].id), { isLatest: true }); promoted.push(list[0].id);
  });
  if (promoted.length) await b.commit();
  return promoted;
}
async function undoDelete(entries, promoted) {
  for (let i = 0; i < entries.length; i += 200) {
    const b = writeBatch(db);
    entries.slice(i, i + 200).forEach((e) => { b.set(doc(db, "sots", e.id), e.data); b.delete(doc(db, "trash", e.tid)); });
    await b.commit();
  }
  if (promoted.length) {
    const b = writeBatch(db);
    promoted.forEach((id) => b.update(doc(db, "sots", id), { isLatest: false }));
    await b.commit();
  }
}

// ---- Toast with optional action button (used for "Undo") ----
function showToast(message, actionLabel, onAction, ms = 12000) {
  let host = document.getElementById("toast-host");
  if (!host) { host = document.createElement("div"); host.id = "toast-host"; document.body.appendChild(host); }
  const t = document.createElement("div");
  t.className = "toast";
  const span = document.createElement("span"); span.textContent = message; t.appendChild(span);
  const close = () => { t.classList.add("out"); setTimeout(() => t.remove(), 250); };
  if (actionLabel) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = actionLabel;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await onAction(); span.textContent = "Done."; b.remove(); setTimeout(close, 1800); }
      catch (err) { span.textContent = "Failed: " + err.message; b.remove(); setTimeout(close, 5000); }
    });
    t.appendChild(b);
  }
  host.appendChild(t);
  if (ms) setTimeout(() => { if (!t.querySelector("button")?.disabled) close(); }, ms);
  return t;
}
function offerUndo(msg, entries, promoted) {
  showToast(msg, "Undo", async () => {
    await undoDelete(entries, promoted);
    await logAudit("undo delete", "", `${entries.length} version(s) restored`);
    invalidateSotCache();
  });
}

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const buyerKey = (item) => String(item.costing?.Customer || "").trim().toLowerCase();
const selectedBuyers = new Set(); // empty = all buyers
let brandFilter = "", categoryFilter = ""; // "" = all
const brandOf = (it) => String(it.costing?.Brand || "").trim();
const categoryOf = (it) => String(it.costing?.["Types of Shoe"] || "").trim();
const passesBuyerFilter = (item) =>
  (selectedBuyers.size === 0 || selectedBuyers.has(buyerKey(item))) &&
  (!brandFilter || brandOf(item) === brandFilter) &&
  (!categoryFilter || categoryOf(item) === categoryFilter);
const anyFilterOn = () => selectedBuyers.size > 0 || !!brandFilter || !!categoryFilter;

function renderBuyerFilters() {
  const labels = new Map();
  (sotCache || []).forEach((it) => {
    const k = buyerKey(it);
    if (!labels.has(k)) labels.set(k, String(it.costing?.Customer || "").trim() || "(no buyer)");
  });
  [...selectedBuyers].forEach((k) => { if (!labels.has(k)) selectedBuyers.delete(k); });
  const buyers = [...labels.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  ["buyer-filter-match", "buyer-filter-search"].forEach((id) => {
    const box = document.getElementById(id);
    box.innerHTML = "";
    if (buyers.length === 0) return;
    const lab = document.createElement("span");
    lab.className = "buyer-filter-label";
    lab.textContent = selectedBuyers.size ? "Buyer:" : "Buyer (none selected = all):";
    box.appendChild(lab);
    buyers.forEach(([k, label]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "buyer-chip" + (selectedBuyers.has(k) ? " on" : "");
      chip.textContent = label;
      chip.addEventListener("click", () => {
        selectedBuyers.has(k) ? selectedBuyers.delete(k) : selectedBuyers.add(k);
        renderBuyerFilters();
        onFilterChange();
      });
      box.appendChild(chip);
    });
    const addSelect = (labelText, values, current, onPick) => {
      const wrap = document.createElement("label");
      wrap.className = "filter-select";
      wrap.append(labelText + " ");
      const sel = document.createElement("select");
      const all = document.createElement("option"); all.value = ""; all.textContent = "All"; sel.appendChild(all);
      values.forEach((v) => { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });
      sel.value = current;
      sel.addEventListener("change", () => { onPick(sel.value); renderBuyerFilters(); onFilterChange(); });
      wrap.appendChild(sel); box.appendChild(wrap);
    };
    const uniq = (fn) => [...new Set((sotCache || []).map(fn).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    addSelect("Brand", uniq(brandOf), brandFilter, (v) => { brandFilter = v; });
    addSelect("Category", uniq(categoryOf), categoryFilter, (v) => { categoryFilter = v; });
    if (anyFilterOn()) {
      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "buyer-clear"; clear.textContent = "Clear";
      clear.addEventListener("click", () => { selectedBuyers.clear(); brandFilter = ""; categoryFilter = ""; renderBuyerFilters(); onFilterChange(); });
      box.appendChild(clear);
    }
  });
}
function onFilterChange() {
  if (lastQueryVector) renderMatchResults();
  runArticleSearch(); // also lists a buyer's articles when nothing is typed
  updateSuggestions();
}

// ============================================================
// Image match tab
// ============================================================
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleMatchFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleMatchFile(fileInput.files[0]); });

let lastQueryVector = null;
let lastQueryFile = null;

async function handleMatchFile(file) {
  const url = URL.createObjectURL(file);
  const preview = document.getElementById("preview-img");
  preview.src = url; preview.hidden = false;
  document.getElementById("dropzone-empty").hidden = true;

  const status = document.getElementById("match-status");
  const results = document.getElementById("match-results");
  results.hidden = true; status.hidden = false; status.textContent = "Loading model + generating embedding…";
  document.getElementById("match-actions").hidden = true;

  try {
    lastQueryFile = file; aiCache = new Map();
    lastQueryVector = await embedImage(url);
    await renderMatchResults();
  } catch (err) {
    status.textContent = "Something went wrong: " + err.message;
  }
}

// Compares the uploaded photo against saved SOTs (only the selected buyers, or all).
async function renderMatchResults() {
  const status = document.getElementById("match-status");
  const results = document.getElementById("match-results");
  status.hidden = false; status.textContent = "Comparing against saved constructions…";
  document.getElementById("match-related").hidden = true; document.getElementById("match-related-head").hidden = true;
  const all = await getAllLatestSots();
  const scored = all
    .filter((d) => d.embedding && d.photoUrl && passesBuyerFilter(d))
    .map((d) => ({ ...d, score: Math.max(cosineSimilarity(lastQueryVector, d.embedding), ...(d.extraPhotos || []).map((p) => cosineSimilarity(lastQueryVector, p.embedding || []))) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    document.getElementById("match-actions").hidden = !canUpload(currentProfile.role);
    results.hidden = true;
    status.textContent = all.length === 0
      ? "No SOT entries in the database yet — add or import some first."
      : "No SOT with a photo for the selected filters.";
    return;
  }
  const top = scored.slice(0, 8);
  renderResults(results, top, true);
  document.getElementById("match-actions").hidden = !canUpload(currentProfile.role);
  status.hidden = true;
  const note = (msg) => { status.hidden = false; status.textContent = msg; };

  if (geminiReady() && lastQueryFile) {
    note("AI is checking the top matches…");
    try {
      // 1) which category is this shoe? then only compare against that category (plus entries with no category)
      let pool = top;
      const catList = [...new Set(all.map(categoryOf).filter(Boolean))].sort(natCmp);
      if (catList.length >= 2) {
        const cats = await classifyQueryCategory(catList).catch(() => []);
        if (cats.length) {
          const want = new Set(cats.map((c) => c.toLowerCase()));
          const inCat = scored.filter((c) => !categoryOf(c) || want.has(categoryOf(c).toLowerCase()));
          if (inCat.length) pool = inCat.slice(0, 16);
          note(`AI sees: ${cats.join(" / ")}. Comparing with ${pool.length} saved ${pool.length === 1 ? "entry" : "entries"} of that kind…`);
          if (inCat.length) renderResults(results, pool.slice(0, 8), true);
        }
      }
      // 2) strict side-by-side check
      const aiTop = await verifyWithGemini(pool);
      // AI is the judge: sort by AI score (visual score only breaks ties); hide the clearly different ones.
      const ranked = aiTop.sort((a, b) => ((b.ai?.score ?? -1) - (a.ai?.score ?? -1)) || (b.score - a.score));
      const matches = ranked.filter((x) => x.ai && (x.ai.verdict === "same" || x.ai.verdict === "similar"));
      const related = ranked.filter((x) => x.ai && x.ai.verdict === "related").slice(0, 4);
      const relBox = document.getElementById("match-related"), relHead = document.getElementById("match-related-head");
      if (matches.length) { renderResults(results, matches, true); status.hidden = true; }
      else { results.hidden = true; }
      if (related.length) { relHead.hidden = false; relBox.hidden = false; renderResults(relBox, related, true); relHead.textContent = matches.length ? "Same family, different style (not a match)" : "Closest in the same family — different style, not a match"; }
      else { relHead.hidden = true; relBox.hidden = true; }
      if (!matches.length) note("No matching construction in the database — this looks like a NEW construction." + (related.length ? " The nearest styles of the same kind are shown below for reference." : "") + " If it really is new, add it with “Add SOT”.");
      return;
    } catch (err) {
      note("AI check unavailable (" + err.message + ") — showing visual similarity only.");
      if (matchPct(top[0].score) < 50) status.textContent += " No close visual match either; this may be a new construction.";
      return;
    }
  }
  if (matchPct(top[0].score) < 50) note("No close match — this looks like a new construction. If it really is new, add it with “Add SOT”.");
}

// ---- Gemini AI check -------------------------------------------------
let aiCache = new Map(); // cache per uploaded photo so changing the buyer filter doesn't re-ask
async function toJpegBase64(blob, maxSide = 512) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
}
const candidateImgCache = new Map(); // photo URL -> base64, so a saved photo is downloaded only once
function candidateJpeg(url) {
  if (!candidateImgCache.has(url)) {
    const p = (async () => {
      const small = url.replace("/upload/", "/upload/w_512,c_limit,q_auto,f_jpg/");
      const res = await fetch(small);
      if (!res.ok) throw new Error("could not load a saved photo");
      return toJpegBase64(await res.blob());
    })();
    p.catch(() => candidateImgCache.delete(url));
    candidateImgCache.set(url, p);
  }
  return candidateImgCache.get(url);
}
// Calls Gemini with the given parts and returns the parsed JSON answer.
// Tries the configured model first, then other free Flash/Flash-Lite models if it is
// overloaded (503/500), rate-limited (429) or not found (404). Retries once per model.
async function geminiJson(parts, preferStrong = false) {
  const strong = ["gemini-3.6-flash", "gemini-3.5-flash"];
  const lite = [geminiCfg.geminiModel, "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
  const models = [...new Set((preferStrong ? [...strong, ...lite] : [...lite, ...strong]).filter(Boolean))];
  const payload = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, responseMimeType: "application/json" } });
  let res = null, lastMsg = "";
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiCfg.geminiApiKey },
        body: payload,
      });
      if (res.ok) break outer;
      const errBody = await res.clone().json().catch(() => null);
      lastMsg = `${res.status}${errBody?.error?.message ? ": " + String(errBody.error.message).slice(0, 140) : ""}`;
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error("API key problem (" + lastMsg + ")");
      if (res.status === 500 || res.status === 503) { await new Promise((r) => setTimeout(r, 1500)); continue; } // retry same model
      break; // 404 / 429 / other → next model
    }
  }
  if (!res || !res.ok) throw new Error(res && res.status === 429 ? "today's free AI limit is used up" : "Google AI is busy, error " + lastMsg);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

// Step 1 of the AI match: which of the factory's own categories (SANDAL, HIGH HEEL, ANKLE BOOT…) is this photo?
// Candidates are then taken only from those categories, so a boot is never compared with a sandal.
const catCache = new Map();
async function classifyQueryCategory(categories) {
  const qSig = lastQueryFile ? `${lastQueryFile.name}|${lastQueryFile.size}|${lastQueryFile.lastModified}` : "";
  const key = qSig + "::" + categories.join("|");
  if (catCache.has(key)) return catCache.get(key);
  const parts = [{
    text:
      "You are a footwear expert. Image 1 is a shoe (a photo or technical drawing). Here are the factory's categories: " + JSON.stringify(categories) + ". " +
      "Pick the 1 or 2 categories that best describe the shoe in Image 1, most likely first. Look at the shoe type and heel height. " +
      "If none of the categories fits at all, return an empty list. Only use category names exactly as written above. " +
      'Return ONLY JSON: {"categories":["..."]}',
  }, { inline_data: { mime_type: "image/jpeg", data: await toJpegBase64(lastQueryFile, 384) } }];
  const json = await geminiJson(parts);
  const wanted = new Set(categories.map((c) => c.toLowerCase()));
  const out = (json.categories || []).map((c) => String(c).trim()).filter((c) => wanted.has(c.toLowerCase())).slice(0, 2);
  catCache.set(key, out);
  return out;
}

async function verifyChunk(candidates) {
  const qSig = lastQueryFile ? `${lastQueryFile.name}|${lastQueryFile.size}|${lastQueryFile.lastModified}` : "";
  const cacheKey = qSig + "::" + candidates.map((c) => c.id).join(",");
  if (aiCache.has(cacheKey)) return candidates.map((c) => ({ ...c, ai: aiCache.get(cacheKey)[c.id] }));

  const letters = "ABCDEFGH";
  const parts = [{
    text:
      "You are a senior footwear development engineer at a shoe factory. Image 1 is the target shoe (a photo or a technical drawing). " +
      "The next images are candidate records from the factory database, labelled A, B, C… with saved details. " +
      "Find out which candidates have the SAME CONSTRUCTION as Image 1. Ignore colour, material finish, lighting, angle, and whether it is a photo or a drawing. " +
      "First look closely at Image 1 and note: shoe family, heel height, toe and strap layout, closure, sole unit. Then, for EACH candidate, answer these checks: " +
      "type_match = same shoe family (open sandal / closed flat / sneaker / boot / heeled pump / espadrille …). " +
      "heel_match = heel height class is the same or neighbouring (flat under 2 cm, low 2-4 cm, mid 4-7 cm, high over 7 cm; flat vs mid/high is NOT a match). " +
      "style_match = the SAME upper layout: thong (toe post) vs slide (wide band over the foot) vs T-strap vs ankle strap vs velcro/sport straps vs closed toe are all DIFFERENT styles. A chunky sport or hiking sandal is NOT the same style as a slim casual sandal. " +
      "sole_match = the sole unit and how it is attached look the same (thin flat sole vs thick lugged or platform sole is NOT a match). " +
      "Be strict and honest: if nothing in the list is the same construction, say so — never inflate scores. " +
      "Score 0-100: 85+ only if all four checks are true; 60-84 if type, heel and style match but the sole differs; 30-59 if only type and heel match; below 30 if type or heel do not match. " +
      'Return ONLY JSON: {"results":[{"id":"A","type_match":true|false,"heel_match":true|false,"style_match":true|false,"sole_match":true|false,"score":0-100,"reason":"one short sentence naming the key difference or likeness"}]}',
  }];
  const [qImg, ...cImgs] = await Promise.all([toJpegBase64(lastQueryFile, 640), ...candidates.map((c) => candidateJpeg(c.photoUrl))]);
  parts.push({ inline_data: { mime_type: "image/jpeg", data: qImg } });
  candidates.forEach((c, i) => {
    parts.push({ text: `Candidate ${letters[i]} — article ${c.article}; type: ${c.costing?.["Types of Shoe"] || c.construction?.Construction || "?"}; brand: ${c.costing?.Brand || "?"}` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: cImgs[i] } });
  });

  const json = await geminiJson(parts, true);
  const byId = {};
  (json.results || []).forEach((r, i) => {
    const idx = letters.indexOf(String(r.id || letters[i]).trim().toUpperCase());
    const cand = candidates[idx];
    if (!cand) return;
    // The rules are enforced here too, so a lenient model answer cannot sneak a wrong shoe type, heel or style in.
    const t = r.type_match !== false, hl = r.heel_match !== false, st = r.style_match !== false, so = r.sole_match !== false;
    let score = Math.max(0, Math.min(100, Number(r.score) || 0));
    let verdict;
    if (!(t && hl)) { verdict = "different"; score = Math.min(score, 29); }
    else if (!st) { verdict = "related"; score = Math.max(30, Math.min(score, 59)); }
    else if (!so) { verdict = "similar"; score = Math.max(60, Math.min(score, 84)); }
    else { verdict = "same"; score = Math.max(85, score); }
    byId[cand.id] = { verdict, score, reason: String(r.reason || ""), checks: { type: t, heel: hl, style: st, sole: so } };
  });
  aiCache.set(cacheKey, byId);
  return candidates.map((c) => ({ ...c, ai: byId[c.id] }));
}

// Checks up to 16 candidates: two batches of 8 asked in parallel.
async function verifyWithGemini(candidates) {
  const chunks = [];
  for (let i = 0; i < candidates.length; i += 8) chunks.push(candidates.slice(i, i + 8));
  const done = await Promise.all(chunks.map((c) => verifyChunk(c)));
  return done.flat();
}

// ============================================================
// Article search tab — suggestions as you type + buyer filter
// ============================================================
let suggestItems = [], suggestActive = -1;
const articleInput = document.getElementById("article-input");
const suggestBox = document.getElementById("suggest-box");

onId("article-search-btn", "click", () => { hideSuggestions(); runArticleSearch(); });
articleInput.addEventListener("focus", () => { getAllLatestSots().then(updateSuggestions).catch(() => {}); });
articleInput.addEventListener("input", updateSuggestions);
articleInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && suggestItems.length) { e.preventDefault(); setActive(Math.min(suggestActive + 1, suggestItems.length - 1)); }
  else if (e.key === "ArrowUp" && suggestItems.length) { e.preventDefault(); setActive(Math.max(suggestActive - 1, 0)); }
  else if (e.key === "Escape") hideSuggestions();
  else if (e.key === "Enter") {
    e.preventDefault();
    if (suggestActive >= 0 && suggestItems[suggestActive]) pickSuggestion(suggestItems[suggestActive]);
    else { hideSuggestions(); runArticleSearch(); }
  }
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap")) hideSuggestions(); });

function hideSuggestions() { suggestBox.hidden = true; suggestItems = []; suggestActive = -1; }
function setActive(i) {
  suggestActive = i;
  [...suggestBox.children].forEach((el, idx) => el.classList.toggle("active", idx === i));
  suggestBox.children[i]?.scrollIntoView({ block: "nearest" });
}
function pickSuggestion(item) {
  articleInput.value = item.article;
  hideSuggestions();
  runArticleSearch({ exact: true });
}
function updateSuggestions() {
  const text = articleInput.value.trim().toLowerCase();
  if (!text || !sotCache) { hideSuggestions(); return; }
  const starts = (it) => String(it.article).toLowerCase().startsWith(text);
  suggestItems = sotCache
    .filter((it) => passesBuyerFilter(it) && String(it.article).toLowerCase().includes(text))
    .sort((a, b) => (starts(b) - starts(a)) || String(a.article).localeCompare(String(b.article)))
    .slice(0, 8);
  suggestActive = -1;
  if (suggestItems.length === 0) {
    suggestBox.innerHTML = `<div class="suggest-item"><span class="s-sub">No article contains “${esc(articleInput.value.trim())}”</span></div>`;
    suggestBox.hidden = false;
    return;
  }
  suggestBox.innerHTML = "";
  suggestItems.forEach((it) => {
    const i = String(it.article).toLowerCase().indexOf(text);
    const art = String(it.article);
    const marked = `${esc(art.slice(0, i))}<mark>${esc(art.slice(i, i + text.length))}</mark>${esc(art.slice(i + text.length))}`;
    const sub = [it.costing?.Customer, it.construction?.Construction].filter(Boolean).join(" · ");
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "suggest-item";
    btn.innerHTML = `${it.photoUrl ? `<img src="${esc(it.photoUrl)}" alt="" />` : ""}<span><span class="s-art">${marked}</span><br><span class="s-sub">${esc(sub) || "—"}</span></span>`;
    btn.addEventListener("click", () => pickSuggestion(it));
    suggestBox.appendChild(btn);
  });
  suggestBox.hidden = false;
}

async function runArticleSearch({ exact = false } = {}) {
  const text = articleInput.value.trim().toLowerCase();
  const resultsBox = document.getElementById("search-results");
  const emptyBox = document.getElementById("search-empty");
  const all = await getAllLatestSots();
  // nothing typed and no buyer selected → nothing to search for
  if (!text && !anyFilterOn()) { resultsBox.hidden = true; emptyBox.hidden = true; return; }
  let items = all.filter(passesBuyerFilter);
  if (text) {
    items = items.filter((it) => {
      const a = String(it.article).trim().toLowerCase();
      return exact ? a === text : a.includes(text);
    });
  }
  items.sort((a, b) => String(a.article).localeCompare(String(b.article)));
  if (items.length === 0) {
    resultsBox.hidden = true; emptyBox.hidden = false;
    emptyBox.textContent = anyFilterOn() ? "No SOT found for the selected filters." : "No SOT found.";
  } else {
    emptyBox.hidden = true;
    renderResults(resultsBox, items.slice(0, 60), false);
  }
}

// ============================================================
// Click a photo to see it large (modal photo)
// ============================================================
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
onId("modal-img", "click", () => {
  const src = document.getElementById("modal-img").src;
  if (!src || src.endsWith("/")) return;
  lightboxImg.src = src;
  lightbox.hidden = false;
});
lightbox.addEventListener("click", () => { lightbox.hidden = true; lightboxImg.src = ""; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") lightbox.hidden = true; });

// ============================================================
// Master table tab — like the SOT Master File: one row per article
// ============================================================
// Page numbers: ‹ 1 2 3 … 12 ›  (used by All articles and the import preview)
function renderPager(box, total, pageSize, page, onChange) {
  box.innerHTML = "";
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) { box.hidden = true; return; }
  box.hidden = false;
  const go = (n) => { if (n >= 1 && n <= pages && n !== page) onChange(n); };
  const add = (label, n, cls = "") => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pg " + cls; b.textContent = label;
    if (n == null) b.disabled = true; else b.addEventListener("click", () => go(n));
    box.appendChild(b);
  };
  add("‹", page > 1 ? page - 1 : null);
  const want = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  let last = 0;
  [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b).forEach((n) => {
    if (n - last > 1) add("…", null, "gap");
    add(String(n), n, n === page ? "on" : "");
    last = n;
  });
  add("›", page < pages ? page + 1 : null);
  const info = document.createElement("span");
  info.className = "pg-info";
  info.textContent = `Page ${page} of ${pages} · rows ${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`;
  box.appendChild(info);
}

const master = { sortKey: "article", dir: 1, page: 1, pageSize: 50, selected: new Set(), filtered: [] };
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
async function renderMaster() {
  const all = await getAllLatestSots();
  const q = document.getElementById("master-search").value.trim().toLowerCase();
  const sel = { customer: document.getElementById("master-customer"), brand: document.getElementById("master-brand"), category: document.getElementById("master-category") };
  const getters = { customer: (it) => String(it.costing?.Customer || "").trim(), brand: brandOf, category: categoryOf };
  Object.keys(sel).forEach((k) => {
    const cur = sel[k].value;
    const vals = [...new Set(all.map(getters[k]).filter(Boolean))].sort(natCmp);
    sel[k].innerHTML = `<option value="">All ${k === "category" ? "categories" : k + "s"}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join("");
    sel[k].value = vals.includes(cur) ? cur : "";
  });
  let items = all.filter((it) =>
    (!sel.customer.value || getters.customer(it) === sel.customer.value) &&
    (!sel.brand.value || brandOf(it) === sel.brand.value) &&
    (!sel.category.value || categoryOf(it) === sel.category.value) &&
    (!q || [it.article, getters.customer(it), brandOf(it), categoryOf(it)].some((v) => String(v || "").toLowerCase().includes(q))));
  const keyVal = { article: (it) => it.article, customer: getters.customer, brand: brandOf, category: categoryOf, sot: (it) => totalMinutes(it.businessSOT) };
  const kv = keyVal[master.sortKey] || keyVal.article;
  items.sort((a, b) => (master.sortKey === "sot" ? kv(a) - kv(b) : natCmp(kv(a), kv(b))) * master.dir);

  const showOps = document.getElementById("master-ops").checked;
  const opCols = showOps ? [...new Set([...BUSINESS_SOT_OPERATIONS, ...items.flatMap((it) => Object.keys(it.businessSOT || {}))])]
    .filter((op) => items.some((it) => Number(it.businessSOT?.[op]) > 0)) : [];
  const cols = [["", "S/L"], ["customer", "Customer"], ["brand", "Brand"], ["category", "Category"], ["article", "Article"], ["", "Picture"], ["sot", "SOT"]];
  const arrow = (k) => (k && k === master.sortKey ? (master.dir > 0 ? " ▲" : " ▼") : "");
  master.filtered = items;
  const allTicked = items.length > 0 && items.every((it) => master.selected.has(it.id));
  const head = `<th class="chk-col"><input type="checkbox" id="master-all" aria-label="Select all" ${allTicked ? "checked" : ""} /></th>` +
    cols.map(([k, l]) => `<th ${k ? `class="sortable" data-sort="${k}"` : ""}>${l}${arrow(k)}</th>`).join("") + opCols.map((op) => `<th class="op-col">${esc(op)}</th>`).join("");
  const pages = Math.max(1, Math.ceil(items.length / master.pageSize));
  if (master.page > pages) master.page = pages;
  const offset = (master.page - 1) * master.pageSize;
  const rows = items.slice(offset, offset + master.pageSize);
  const body = rows.map((it, i) => `<tr data-i="${i}" class="${master.selected.has(it.id) ? "picked" : ""}">
    <td class="chk-col"><input type="checkbox" class="row-chk" ${master.selected.has(it.id) ? "checked" : ""} aria-label="Select ${esc(it.article)}" /></td>
    <td>${offset + i + 1}</td><td>${esc(getters.customer(it))}</td><td>${esc(brandOf(it))}</td><td>${esc(categoryOf(it))}</td>
    <td><strong>${esc(it.article)}</strong>${it.incomplete ? ' <span class="inc-badge">Incomplete</span>' : ""}</td>
    <td>${it.photoUrl ? `<img class="master-thumb" loading="lazy" src="${esc(it.photoUrl.replace("/upload/", "/upload/w_120,c_limit,q_auto/"))}" />` : ""}</td>
    <td>${totalMinutes(it.businessSOT) > 0 ? totalMinutes(it.businessSOT).toFixed(1) : ""}</td>
    ${opCols.map((op) => `<td class="op-col">${Number(it.businessSOT?.[op]) > 0 ? it.businessSOT[op] : ""}</td>`).join("")}</tr>`).join("");
  const table = document.getElementById("master-table");
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  table.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort; master.dir = master.sortKey === k ? -master.dir : 1; master.sortKey = k; master.page = 1; renderMaster();
  }));
  table.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest(".chk-col")) return;
    matchFlow = false; openModal(rows[Number(tr.dataset.i)]);
  }));
  table.querySelectorAll(".row-chk").forEach((cb) => cb.addEventListener("change", () => {
    const it = rows[Number(cb.closest("tr").dataset.i)];
    cb.checked ? master.selected.add(it.id) : master.selected.delete(it.id);
    cb.closest("tr").classList.toggle("picked", cb.checked);
    updateMasterToolbar();
  }));
  onId("master-all", "change", (e) => {
    master.filtered.forEach((it) => (e.target.checked ? master.selected.add(it.id) : master.selected.delete(it.id)));
    renderMaster();
  });
  updateMasterToolbar();
  document.getElementById("master-count").textContent = `${items.length} article${items.length === 1 ? "" : "s"}`;
  const pager = document.getElementById("master-pager");
  if (pager) renderPager(pager, items.length, master.pageSize, master.page, (n) => { master.page = n; renderMaster(); document.getElementById("tab-master").scrollIntoView({ block: "start" }); });
  const more = document.getElementById("master-more"); if (more) more.hidden = true;
}
// ---- Selection toolbar: compare, export, bulk edit, bulk delete ----
function selectedItems() { const ids = master.selected; return (sotCache || []).filter((it) => ids.has(it.id)); }
function updateMasterToolbar() {
  const n = master.selected.size;
  const bar = document.getElementById("master-selbar");
  bar.hidden = n === 0;
  document.getElementById("sel-count").textContent = `${n} selected`;
  document.getElementById("sel-compare").disabled = n !== 2;
  document.getElementById("sel-compare").title = n === 2 ? "" : "Select exactly 2 articles to compare";
  document.getElementById("sel-edit").hidden = !canUpload(currentProfile.role);
  document.getElementById("sel-delete").hidden = !canManageUsers(currentProfile.role);
  document.getElementById("master-export").textContent = n ? `Export ${n} to Excel` : "Export to Excel";
  const pb = document.getElementById("master-export-pics"); if (pb && !pb.disabled) pb.textContent = n ? `Export ${n} with photos` : "Export with photos";
}
onId("sel-clear", "click", () => { master.selected.clear(); renderMaster(); });

async function exportMaster() {
  const btn = document.getElementById("master-export");
  const list = master.selected.size ? selectedItems() : master.filtered;
  if (!list.length) return;
  btn.disabled = true;
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const X = XLSX.default || XLSX;
    const ops = [...new Set([...BUSINESS_SOT_OPERATIONS, ...list.flatMap((it) => Object.keys(it.businessSOT || {}))])]
      .filter((op) => list.some((it) => Number(it.businessSOT?.[op]) > 0));
    const aoa = [["S/L", "CUSTOMER", "BRAND", "CATEGORY", "ARTICLE", "SOT", ...ops.map((o) => o.toUpperCase())]];
    list.forEach((it, i) => aoa.push([i + 1, it.costing?.Customer || "", brandOf(it), categoryOf(it), it.article,
      Math.round(totalMinutes(it.businessSOT) * 100) / 100, ...ops.map((op) => (Number(it.businessSOT?.[op]) > 0 ? it.businessSOT[op] : ""))]));
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), "SOT");
    X.writeFile(wb, `SOT-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
    logAudit("exported", "", `${list.length} article(s)`);
  } catch (err) { alert("Could not export: " + err.message); }
  btn.disabled = false;
}
onId("master-export", "click", exportMaster);

// Excel with the shoe photos embedded (ExcelJS is loaded only when this is used)
function loadScriptOnce(url, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url; el.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(globalName + " did not load")));
    el.onerror = () => reject(new Error("Could not download the Excel library (check internet)."));
    document.head.appendChild(el);
  });
}
async function fetchThumb(url) {
  const u = url.replace("/upload/", "/upload/w_220,h_220,c_limit,q_auto:good,f_jpg/");
  const res = await fetch(u);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.arrayBuffer();
}
async function exportMasterWithPhotos() {
  const btn = document.getElementById("master-export-pics");
  const list = master.selected.size ? selectedItems() : master.filtered;
  if (!list.length) return;
  if (list.length > 400 && !confirm(`${list.length} rows with photos will make a big file and take a few minutes. Continue?\n(Tip: filter by customer first, or select fewer rows.)`)) return;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = "Loading Excel library…";
    const ExcelJS = await loadScriptOnce("https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js", "ExcelJS");
    const ops = [...new Set([...BUSINESS_SOT_OPERATIONS, ...list.flatMap((it) => Object.keys(it.businessSOT || {}))])]
      .filter((op) => list.some((it) => Number(it.businessSOT?.[op]) > 0));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("SOT", { views: [{ state: "frozen", ySplit: 1, xSplit: 0 }] });
    const head = ["S/L", "CUSTOMER", "BRAND", "CATEGORY", "ARTICLE", "PHOTO", "SOT", ...ops.map((o) => o.toUpperCase())];
    ws.addRow(head);
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E6B57" } };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    ws.getRow(1).height = 24;
    ws.columns = head.map((h, i) => ({ width: i === 5 ? 17 : i === 0 ? 5 : i < 5 ? 15 : 10 }));
    list.forEach((it, i) => {
      const r = ws.addRow([i + 1, it.costing?.Customer || "", brandOf(it), categoryOf(it), it.article, "",
        Math.round(totalMinutes(it.businessSOT) * 100) / 100, ...ops.map((op) => (Number(it.businessSOT?.[op]) > 0 ? Number(it.businessSOT[op]) : ""))]);
      r.height = 84;
      r.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
    // download photos, 6 at a time
    let done = 0, noPhoto = 0, next = 0;
    const bufs = new Array(list.length);
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        try { if (list[i].photoUrl) bufs[i] = await fetchThumb(list[i].photoUrl); } catch (e) { noPhoto++; }
        done++;
        btn.textContent = `Photos ${done} / ${list.length}…`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    bufs.forEach((buf, i) => {
      if (!buf) return;
      const id = wb.addImage({ buffer: buf, extension: "jpeg" });
      ws.addImage(id, { tl: { col: 5.08, row: i + 1.06 }, ext: { width: 100, height: 100 }, editAs: "oneCell" });
    });
    btn.textContent = "Building file…";
    const out = await wb.xlsx.writeBuffer();
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `SOT-with-photos-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    logAudit("exported", "", `${list.length} article(s) with photos`);
    if (noPhoto) showToast(`${noPhoto} photo(s) could not be loaded and were left blank.`, null, null, 8000);
  } catch (err) { alert("Could not export: " + err.message); }
  btn.textContent = label;
  btn.disabled = false;
}
onId("master-export-pics", "click", exportMasterWithPhotos);

function openCompare() {
  const [a, b] = selectedItems();
  if (!a || !b) return;
  const ops = [...new Set([...BUSINESS_SOT_OPERATIONS, ...Object.keys(a.businessSOT || {}), ...Object.keys(b.businessSOT || {})])]
    .filter((op) => Number(a.businessSOT?.[op]) > 0 || Number(b.businessSOT?.[op]) > 0);
  const num = (v) => (Number(v) > 0 ? Number(v) : 0);
  const side = (it) => `<div class="cmp-head">${it.photoUrl ? `<img src="${esc(it.photoUrl)}" />` : ""}<div><strong>${esc(it.article)}</strong><div class="muted">${esc([it.costing?.Customer, brandOf(it), categoryOf(it)].filter(Boolean).join(" · "))}</div></div></div>`;
  const rows = ops.map((op) => {
    const x = num(a.businessSOT?.[op]), y = num(b.businessSOT?.[op]), d = Math.round((y - x) * 100) / 100;
    return `<tr class="${d ? "cmp-diff" : ""}"><td>${esc(op)}</td><td>${x || ""}</td><td>${y || ""}</td><td>${d ? (d > 0 ? "+" : "") + d : "same"}</td></tr>`;
  }).join("");
  const ta = Math.round(totalMinutes(a.businessSOT) * 100) / 100, tb = Math.round(totalMinutes(b.businessSOT) * 100) / 100, td = Math.round((tb - ta) * 100) / 100;
  document.getElementById("compare-body").innerHTML = `
    <div class="cmp-top">${side(a)}${side(b)}</div>
    <table class="sot-table cmp-table"><tr><th>Operation</th><th>${esc(a.article)}</th><th>${esc(b.article)}</th><th>Difference</th></tr>${rows}
    <tr class="total"><td>Total</td><td>${ta}</td><td>${tb}</td><td>${td > 0 ? "+" : ""}${td}</td></tr></table>
    <p class="muted" style="margin-top:10px;">Difference = second minus first. Highlighted rows differ.</p>`;
  document.getElementById("compare-backdrop").hidden = false;
}
onId("sel-compare", "click", openCompare);
onId("compare-close", "click", () => (document.getElementById("compare-backdrop").hidden = true));
onId("compare-backdrop", "click", (e) => { if (e.target.id === "compare-backdrop") e.target.hidden = true; });

onId("sel-edit", "click", () => { document.getElementById("bulk-panel").hidden = !document.getElementById("bulk-panel").hidden; });
onId("bulk-apply", "click", async () => {
  if (!canUpload(currentProfile.role)) return;
  const field = document.getElementById("bulk-field").value;
  const value = document.getElementById("bulk-value").value.trim();
  const ids = [...master.selected];
  if (!ids.length) return;
  if (!value && !confirm(`Clear ${field} on ${ids.length} article(s)?`)) return;
  if (value && !confirm(`Set ${field} to “${value}” on ${ids.length} article(s)?`)) return;
  const btn = document.getElementById("bulk-apply"); btn.disabled = true;
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const b = writeBatch(db);
      ids.slice(i, i + 400).forEach((id) => b.update(doc(db, "sots", id), { [`costing.${field}`]: value }));
      await b.commit();
    }
    await logAudit("bulk edit", "", `${field} = “${value}” on ${ids.length} article(s)`);
    document.getElementById("bulk-panel").hidden = true; document.getElementById("bulk-value").value = "";
    invalidateSotCache();
  } catch (err) { alert("Could not update: " + err.message); }
  btn.disabled = false;
});
onId("sel-delete", "click", async () => {
  if (!canManageUsers(currentProfile.role)) return;
  const chosen = selectedItems();
  if (!chosen.length) return;
  if (!confirm(`Delete ${chosen.length} article(s) with all their versions?\nThey go to the recycle bin for 30 days.`)) return;
  const btn = document.getElementById("sel-delete"); btn.disabled = true;
  try {
    const arts = new Set(chosen.map((c) => c.article));
    const all = await getAllSotDocs();
    const mine = all.filter((d) => arts.has(d.article));
    const entries = await moveToTrash(mine);
    await logAudit("bulk deleted", "", `${arts.size} article(s), ${mine.length} version(s)`);
    master.selected.clear();
    invalidateSotCache();
    offerUndo(`Deleted ${arts.size} article(s).`, entries, []);
  } catch (err) { alert("Could not delete: " + err.message); }
  btn.disabled = false;
});

["master-search"].forEach((id) => onId(id, "input", () => { master.page = 1; renderMaster(); }));
["master-customer", "master-brand", "master-category", "master-ops"].forEach((id) => onId(id, "change", () => { master.page = 1; renderMaster(); }));

// ============================================================
// Data quality — what is missing or looks wrong, with a Fix button
// ============================================================
const QUALITY_CHECKS = [
  ["incomplete", "Marked incomplete"],
  ["nophoto", "No photo"],
  ["nosot", "No SOT minutes"],
  ["nocustomer", "No customer"],
  ["nobrand", "No brand"],
  ["nocategory", "No category"],
  ["outlier", "Unusual SOT"],
];
let qualityFilter = "all";
function computeQuality(items) {
  // typical SOT per category (median) to spot values that are far off
  const byCat = new Map();
  items.forEach((it) => { const t = totalMinutes(it.businessSOT); if (t > 0 && categoryOf(it)) { const k = categoryOf(it).toLowerCase(); if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(t); } });
  const median = new Map();
  byCat.forEach((arr, k) => { if (arr.length >= 4) { arr.sort((a, b) => a - b); median.set(k, arr[Math.floor(arr.length / 2)]); } });
  const issues = [];
  items.forEach((it) => {
    const list = [];
    if (it.incomplete) list.push(["incomplete", `Marked incomplete${it.incomplete.by ? " by " + it.incomplete.by : ""}${it.incomplete.at ? " · " + new Date(it.incomplete.at).toLocaleDateString() : ""}${it.incomplete.note ? " — " + it.incomplete.note : ""}`]);
    const noEmb = !Array.isArray(it.embedding) || !it.embedding.some((v) => v);
    if (!it.photoUrl || noEmb) list.push(["nophoto", it.photoUrl ? "Photo not readable by AI" : "No photo"]);
    const tot = totalMinutes(it.businessSOT);
    if (!(tot > 0)) list.push(["nosot", "No SOT minutes"]);
    if (!String(it.costing?.Customer || "").trim()) list.push(["nocustomer", "No customer"]);
    if (!brandOf(it)) list.push(["nobrand", "No brand"]);
    if (!categoryOf(it)) list.push(["nocategory", "No category"]);
    const med = median.get(categoryOf(it).toLowerCase());
    if (med && tot > 0 && (tot > med * 2 || tot < med / 2)) list.push(["outlier", `SOT ${Math.round(tot * 10) / 10} min vs usual ~${Math.round(med)} for ${categoryOf(it)}`]);
    if (list.length) issues.push({ item: it, list });
  });
  return issues;
}
async function renderQuality() {
  const items = await getAllLatestSots();
  const issues = computeQuality(items);
  const counts = {}; QUALITY_CHECKS.forEach(([k]) => (counts[k] = issues.filter((x) => x.list.some(([c]) => c === k)).length));
  const chips = document.getElementById("quality-chips");
  chips.innerHTML = "";
  const mkChip = (key, label, n) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "q-chip" + (qualityFilter === key ? " on" : "") + (n ? "" : " zero");
    b.innerHTML = `<strong>${n}</strong><span>${esc(label)}</span>`;
    b.addEventListener("click", () => { qualityFilter = qualityFilter === key ? "all" : key; renderQuality(); });
    chips.appendChild(b);
  };
  mkChip("all", "Articles to check", issues.length);
  QUALITY_CHECKS.forEach(([k, l]) => mkChip(k, l, counts[k]));
  const list = document.getElementById("quality-list");
  list.innerHTML = "";
  const shown = issues.filter((x) => qualityFilter === "all" || x.list.some(([c]) => c === qualityFilter));
  document.getElementById("quality-summary").textContent = items.length
    ? `${items.length} articles checked · ${issues.length} need attention` : "No articles yet.";
  if (!shown.length) { list.innerHTML = `<p class="muted" style="padding:12px 0;">${items.length ? "Nothing to fix here — all good." : ""}</p>`; return; }
  shown.slice(0, 300).forEach(({ item, list: ls }) => {
    const row = document.createElement("div");
    row.className = "q-row";
    row.innerHTML = `
      <img src="${esc((item.photoUrl || "").replace("/upload/", "/upload/w_120,c_limit,q_auto/"))}" alt="" />
      <div class="q-main"><strong>${esc(item.article)}</strong> <span class="muted">${esc([item.costing?.Customer, item.costing?.Brand].filter(Boolean).join(" · "))}</span>
        <div class="q-tags">${ls.map(([, t]) => `<span class="q-tag">${esc(t)}</span>`).join("")}</div></div>
      <div class="q-act"><button type="button" class="btn-small q-open">Open</button>${canUpload(currentProfile.role) ? `<button type="button" class="btn-small q-fix">Fix</button>` : ""}</div>`;
    row.querySelector(".q-open").addEventListener("click", () => { matchFlow = false; openModal(item); });
    row.querySelector(".q-fix")?.addEventListener("click", () => enterEditMode(item));
    list.appendChild(row);
  });
  if (shown.length > 300) { const p = document.createElement("p"); p.className = "muted"; p.textContent = `…and ${shown.length - 300} more. Fix these first, the rest will show up.`; list.appendChild(p); }
}

// ============================================================
// Add SOT tab — fixed Business SOT rows + duplicate/version notice
// ============================================================
const sotTable = document.getElementById("add-sot-table");
function addSotRow(op = "", min = "", locked = false) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${locked
      ? `<span>${op}</span><input type="hidden" class="sot-op" value="${op}" />`
      : `<input type="text" class="sot-op" value="${op}" placeholder="e.g. Cutting" />`}</td>
    <td><input type="number" step="any" min="0" class="sot-min" value="${min}" style="width:90px;" /></td>
    <td>${`<button type="button" class="btn-small btn-danger row-remove">✕</button>`}</td>`;
  tr.querySelector(".row-remove").addEventListener("click", () => { tr.remove(); updateSotTotal(); });
  tr.querySelectorAll("input.sot-min").forEach((inp) => inp.addEventListener("input", updateSotTotal));
  sotTable.appendChild(tr);
}
function updateSotTotal() {
  let total = 0;
  sotTable.querySelectorAll(".sot-min").forEach((inp) => (total += Number(inp.value || 0)));
  document.getElementById("add-sot-total").textContent = total.toFixed(1);
}
onId("add-sot-row", "click", () => addSotRow());
const extraOpSelect = document.getElementById("add-sot-extra");
EXTRA_OPERATIONS.forEach((op) => { const o = document.createElement("option"); o.value = op; o.textContent = op; extraOpSelect.appendChild(o); });
extraOpSelect.addEventListener("change", () => {
  const op = extraOpSelect.value; extraOpSelect.value = "";
  if (!op) return;
  const have = Array.from(sotTable.querySelectorAll(".sot-op")).find((i) => i.value === op);
  if (have) { have.closest("tr").querySelector(".sot-min").focus(); return; }
  addSotRow(op, "", true);
  sotTable.querySelector("tr:last-child .sot-min").focus();
});
CORE_OPERATIONS.forEach((op) => addSotRow(op, "", true));

function resetSotTable() {
  sotTable.querySelectorAll("tr").forEach((tr, i) => { if (i > 0) tr.remove(); });
  CORE_OPERATIONS.forEach((op) => addSotRow(op, "", true));
}

const dupNotice = document.getElementById("duplicate-notice");
onId("add-article", "blur", async (e) => {
  const val = e.target.value.trim();
  dupNotice.style.display = "none";
  if (!val) return;
  const snap = await getDocs(query(collection(db, "sots"), where("article", "==", val), where("isLatest", "==", true)));
  if (!snap.empty) {
    const existing = snap.docs[0].data();
    dupNotice.style.display = "block";
    dupNotice.textContent = `"${val}" already exists (last saved ${existing.year}). Saving now will keep that as history and add this as a new version.`;
  }
});

function collectAddForm() {
  const businessSOT = {};
  sotTable.querySelectorAll("tr").forEach((tr, i) => {
    if (i === 0) return;
    const opInput = tr.querySelector(".sot-op");
    const minInput = tr.querySelector(".sot-min");
    if (opInput && opInput.value.trim() && minInput.value !== "") businessSOT[opInput.value.trim()] = Number(minInput.value);
  });
  return {
    article: document.getElementById("add-article").value.trim(),
    construction: {},
    costing: {
      Customer: document.getElementById("add-customer").value.trim(),
      Brand: document.getElementById("add-brand").value.trim(),
      "Types of Shoe": document.getElementById("add-category").value.trim(),
    },
    businessSOT,
    efficiency: {},
    notes: {},
    // "complete it later" flag — shown in Data quality for everyone to see
    incomplete: document.getElementById("add-incomplete")?.checked
      ? { by: currentProfile?.name || currentUser?.email || "", at: Date.now(), note: (document.getElementById("add-incomplete-note")?.value || "").trim().slice(0, 200) }
      : null,
  };
}

const removedExtra = new Set(); // extra photos the user crossed out while editing
let baseItem = null; // the entry being edited / versioned, so fields the form has no box for are not lost
let editingId = null; // set when the Add form is being used to edit an existing doc, instead of creating one

onId("add-incomplete", "change", (e) => { const n = document.getElementById("add-incomplete-note"); if (n) { n.hidden = !e.target.checked; if (e.target.checked) n.focus(); } });
onId("form-add-sot", "submit", async (e) => {
  e.preventDefault();
  const statusBox = document.getElementById("add-status");
  statusBox.hidden = false;
  const photoFile = document.getElementById("add-photo").files[0];

  try {
    const formData = collectAddForm();
    if (baseItem) ["construction", "costing", "efficiency", "notes", "extra"].forEach((k) => { formData[k] = { ...(baseItem[k] || {}), ...formData[k] }; });
    // extra photos: keep the ones not removed, add the newly chosen ones
    const extraFiles = [...document.getElementById("add-photos-extra").files];
    formData.extraPhotos = (baseItem?.extraPhotos || []).filter((p) => !removedExtra.has(p.url));
    for (let i = 0; i < extraFiles.length; i++) {
      statusBox.textContent = `Uploading extra photo ${i + 1} of ${extraFiles.length}…`;
      const url = await uploadToCloudinary(extraFiles[i]);
      formData.extraPhotos.push({ url, embedding: await embedImage(url) });
    }

    if (editingId) {
      // Editing in place: only touch the photo/embedding if a new photo was chosen.
      statusBox.textContent = "Saving changes…";
      const update = { ...formData };
      if (photoFile) {
        statusBox.textContent = "Uploading new photo…";
        update.photoUrl = await uploadToCloudinary(photoFile);
        statusBox.textContent = "Generating embedding…";
        update.embedding = await embedImage(update.photoUrl);
      }
      await updateDoc(doc(db, "sots", editingId), update);
      logAudit("edited", formData.article);
      invalidateSotCache();
      statusBox.textContent = "Entry updated.";
      exitEditMode();
    } else {
      let photoUrl, embedding;
      if (copyMode) {
        if (String(formData.article).trim().toLowerCase() === String(baseItem.article).trim().toLowerCase())
          throw new Error("Type a NEW article number — this is a copy, not a new version of " + baseItem.article + ".");
      }
      const keepPhoto = copyMode && !photoFile && document.getElementById("copy-same-photo")?.checked;
      if (keepPhoto) {
        photoUrl = baseItem.photoUrl; embedding = baseItem.embedding;
      } else {
        statusBox.textContent = "Uploading photo…";
        photoUrl = await uploadToCloudinary(photoFile);
        statusBox.textContent = "Generating embedding…";
        embedding = await embedImage(photoUrl);
      }
      statusBox.textContent = "Saving…";
      const isNewVersion = await saveSotWithVersioning({ ...formData, photoUrl, embedding });
      logAudit(isNewVersion ? "new version" : "added", formData.article);
      statusBox.textContent = isNewVersion
        ? `Saved as a new version of ${formData.article}. Previous data kept as history.`
        : "Saved.";
    }
    dupNotice.style.display = "none";
    e.target.reset();
    { const n = document.getElementById("add-incomplete-note"); if (n) n.hidden = true; }
    resetSotTable();
    exitEditMode();
  } catch (err) {
    statusBox.textContent = "Failed: " + err.message;
  }
});

// ---- Add-form modes: update in place / new version / brand-new entry ----
function renderExtraPhotoList() {
  const box = document.getElementById("extra-photo-list");
  box.innerHTML = "";
  (baseItem?.extraPhotos || []).forEach((p) => {
    const gone = removedExtra.has(p.url);
    const d = document.createElement("div");
    d.className = "extra-thumb" + (gone ? " gone" : "");
    d.innerHTML = `<img src="${esc(p.url.replace("/upload/", "/upload/w_160,c_limit,q_auto/"))}" /><button type="button" title="${gone ? "Keep" : "Remove"}">${gone ? "↺" : "✕"}</button>`;
    d.querySelector("button").addEventListener("click", () => { gone ? removedExtra.delete(p.url) : removedExtra.add(p.url); renderExtraPhotoList(); });
    box.appendChild(d);
  });
}
function fillAddForm(item) {
  removedExtra.clear();
  setTimeout(renderExtraPhotoList, 0);
  document.getElementById("add-article").value = item.article || "";
  document.getElementById("add-customer").value = item.costing?.Customer || "";
  document.getElementById("add-brand").value = item.costing?.Brand || "";
  document.getElementById("add-category").value = item.costing?.["Types of Shoe"] || "";
  const inc = document.getElementById("add-incomplete"), incNote = document.getElementById("add-incomplete-note");
  if (inc) { inc.checked = !!item.incomplete; if (incNote) { incNote.value = item.incomplete?.note || ""; incNote.hidden = !inc.checked; } }

  resetSotTable();
  Object.entries(item.businessSOT || {}).forEach(([op, min]) => {
    const lockedRow = Array.from(sotTable.querySelectorAll("tr")).find((tr) => tr.querySelector(".sot-op")?.value === op);
    if (lockedRow) lockedRow.querySelector(".sot-min").value = min;
    else addSotRow(op, min, BUSINESS_SOT_OPERATIONS.includes(op));
  });
  updateSotTotal();

}

function showAddTab() {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('[data-tab="tab-upload"]').classList.add("active");
  document.getElementById("tab-upload").classList.add("active");
  backdrop.hidden = true;
  window.scrollTo({ top: 0 });
}

function setBanner(text) {
  const b = document.getElementById("add-mode-banner");
  b.textContent = text || "";
  b.style.display = text ? "block" : "none";
}

// Photo from the image-match search can be reused as this entry's photo.
function setMatchPhoto(on) {
  const input = document.getElementById("add-photo");
  if (on && lastQueryFile) {
    const dt = new DataTransfer();
    dt.items.add(new File([lastQueryFile], lastQueryFile.name || "match.jpg", { type: lastQueryFile.type || "image/jpeg" }));
    input.files = dt.files;
  } else {
    input.value = "";
  }
}
function setupMatchPhotoBar(defaultOn, label) {
  const bar = document.getElementById("match-photo-bar");
  if (!matchFlow || !lastQueryFile) { bar.hidden = true; return; }
  document.getElementById("match-photo-thumb").src = URL.createObjectURL(lastQueryFile);
  document.getElementById("match-photo-label").textContent = label;
  const cb = document.getElementById("use-match-photo");
  cb.checked = defaultOn;
  cb.onchange = () => setMatchPhoto(cb.checked);
  bar.hidden = false;
  setMatchPhoto(defaultOn);
}

function setSubmitLabel(t) { document.getElementById("form-add-sot").querySelector('button[type="submit"]').textContent = t; }

// 1) Edit this exact document (no versioning)
function enterEditMode(item) {
  editingId = item.id; baseItem = item;
  fillAddForm(item);
  document.getElementById("add-photo").required = false; // keep existing photo unless a new one is chosen
  setSubmitLabel("Update entry");
  setBanner(`Updating the existing entry ${item.article} (changes overwrite it). Check every field, change what is wrong, then press Update entry.`);
  dupNotice.style.display = "none";
  setupMatchPhotoBar(false, "Replace this entry's photo with the one I uploaded for matching");
  showAddTab();
}

// 2) Same article, new dated card — old one stays as history
function enterNewVersionMode(item) {
  editingId = null; baseItem = item;
  document.getElementById("form-add-sot").reset();
  fillAddForm(item);
  document.getElementById("add-photo").required = true;
  setSubmitLabel("Save as new version");
  setBanner(`New version of ${item.article}. The old card is kept as history. Check every field, change what is different, then press Save as new version.`);
  dupNotice.style.display = "none";
  setupMatchPhotoBar(true, "Use the photo I uploaded for matching as this version's photo");
  if (!matchFlow || !lastQueryFile) document.getElementById("match-photo-bar").hidden = true;
  showAddTab();
}

// 3) Nothing matched — brand-new entry, uploaded photo pre-attached
function enterNewEntryMode() {
  editingId = null; baseItem = null;
  matchFlow = true;
  document.getElementById("form-add-sot").reset();
  resetSotTable();
  document.getElementById("add-photo").required = true;
  setSubmitLabel("Save entry");
  setBanner("New entry. Fill in the details — your uploaded photo is already attached.");
  dupNotice.style.display = "none";
  setupMatchPhotoBar(true, "Use the photo I uploaded for matching");
  showAddTab();
}
onId("match-new-btn", "click", enterNewEntryMode);

let copyMode = false;
function setCopyPhotoBar(on) {
  const bar = document.getElementById("copy-photo-bar");
  if (bar) bar.hidden = !on;
  const cb = document.getElementById("copy-same-photo");
  if (cb) {
    cb.checked = on;
    cb.onchange = () => { document.getElementById("add-photo").required = !cb.checked; };
  }
}
// 4) Copy as a NEW SOT: same data, different article number (a different shoe that is built almost the same)
function enterCopyMode(item) {
  editingId = null; matchFlow = false; copyMode = true;
  baseItem = { ...item, extraPhotos: [] };
  document.getElementById("form-add-sot").reset();
  fillAddForm(item);
  document.getElementById("add-article").value = "";
  document.getElementById("add-photo").required = false;
  setCopyPhotoBar(true);
  setSubmitLabel("Save as new SOT");
  setBanner(`Copy of ${item.article}. Type the NEW article number, change what is different, then press Save as new SOT. The original stays untouched.`);
  dupNotice.style.display = "none";
  document.getElementById("match-photo-bar").hidden = true;
  showAddTab();
  setTimeout(() => document.getElementById("add-article").focus(), 50);
}

function exitEditMode() {
  editingId = null; baseItem = null; removedExtra.clear(); renderExtraPhotoList();
  copyMode = false; setCopyPhotoBar(false);
  matchFlow = false;
  document.getElementById("add-photo").required = true;
  setSubmitLabel("Save entry");
  setBanner("");
  document.getElementById("match-photo-bar").hidden = true;
}

// ============================================================
// Detail modal — construction, costing, Business SOT, efficiency,
// notes, and other versions of the same article
// ============================================================
const backdrop = document.getElementById("modal-backdrop");
// ---- Delete (Master / Master God only; goes to the recycle bin for 30 days) ----
async function deleteSotVersion(item) {
  if (!canManageUsers(currentProfile.role)) return;
  if (!confirm(`Delete SOT ${item.article}${item.year ? " (" + item.year + ")" : ""}?\nIt goes to the recycle bin for 30 days.`)) return;
  try {
    const all = await getAllSotDocs();
    const entries = await moveToTrash(all.filter((d) => d.id === item.id));
    const promoted = await fixLatestFlags(all.filter((d) => d.id !== item.id), new Set([item.article]));
    await logAudit("deleted", item.article, item.year ? "version " + item.year : "");
    backdrop.hidden = true;
    invalidateSotCache();
    offerUndo(`Deleted ${item.article}${item.year ? " (" + item.year + ")" : ""}.`, entries, promoted);
  } catch (err) { alert("Could not delete: " + err.message); }
}
async function deleteSotArticle(item) {
  if (!canManageUsers(currentProfile.role)) return;
  if (!confirm(`Delete article ${item.article} with ALL its versions?\nThey go to the recycle bin for 30 days.`)) return;
  try {
    const all = await getAllSotDocs();
    const mine = all.filter((d) => d.article === item.article);
    const entries = await moveToTrash(mine);
    await logAudit("deleted article", item.article, mine.length + " version(s)");
    backdrop.hidden = true;
    invalidateSotCache();
    offerUndo(`Deleted article ${item.article} (${mine.length} version${mine.length === 1 ? "" : "s"}).`, entries, []);
  } catch (err) { alert("Could not delete: " + err.message); }
}

// ---- Print / save as PDF: one clean page per SOT with the shoe photo ----
function printCard(item) {
  let sheet = document.getElementById("print-sheet");
  if (!sheet) { sheet = document.createElement("div"); sheet.id = "print-sheet"; document.body.appendChild(sheet); }
  const big = (u) => esc((u || "").replace("/upload/", "/upload/w_1000,c_limit,q_auto/"));
  const small = (u) => esc((u || "").replace("/upload/", "/upload/w_300,c_limit,q_auto/"));
  const kv = (title, obj) => {
    const rows = Object.entries(obj || {}).filter(([, v]) => v !== "" && v != null && v !== 0);
    return rows.length ? `<h3>${title}</h3><table class="pt kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>` : "";
  };
  const ops = Object.entries(item.businessSOT || {}).filter(([, v]) => Number(v) > 0);
  const total = totalMinutes(item.businessSOT);
  const meta = [item.costing?.Customer, item.costing?.Brand, item.costing?.["Types of Shoe"]].filter(Boolean).join(" · ");
  sheet.innerHTML = `
    <div class="p-head">
      <div><div class="p-art">${esc(item.article)}${item.year ? ` <span>(${esc(item.year)})</span>` : ""}</div>
        <div class="p-name">${esc(item.construction?.Construction || item.costing?.["Types of Shoe"] || "")}</div>
        <div class="p-meta">${esc(meta)}</div></div>
      <div class="p-stamp">SOT card<br>Printed ${new Date().toLocaleDateString()}</div>
    </div>
    <div class="p-top">
      <div class="p-photo">${item.photoUrl ? `<img src="${big(item.photoUrl)}" />` : ""}</div>
      <div class="p-ops"><h3>Business SOT</h3>
        ${ops.length ? `<table class="pt ops">${ops.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join("")}<tr class="tot"><td>Total (min)</td><td class="n">${Math.round(total * 100) / 100}</td></tr></table>` : `<p class="muted">No operations recorded.</p>`}
      </div>
    </div>
    ${(item.extraPhotos || []).length ? `<div class="p-extra">${item.extraPhotos.slice(0, 6).map((p) => `<img src="${small(p.url)}" />`).join("")}</div>` : ""}
    <div class="p-cols">
      <div>${kv("Construction", item.construction)}${kv("Costing", item.costing)}</div>
      <div>${kv("Efficiency", item.efficiency)}${kv("Notes", item.notes)}${kv("Other", item.extra)}</div>
    </div>`;
  const imgs = [...sheet.querySelectorAll("img")];
  const ready = Promise.all(imgs.map((im) => (im.complete ? 1 : new Promise((r) => { im.onload = im.onerror = r; }))));
  const oldTitle = document.title;
  document.title = `SOT ${item.article}`;
  document.body.classList.add("printing");
  const after = () => { document.body.classList.remove("printing"); document.title = oldTitle; window.removeEventListener("afterprint", after); };
  window.addEventListener("afterprint", after);
  Promise.race([ready, new Promise((r) => setTimeout(r, 6000))]).then(() => setTimeout(() => window.print(), 150));
}

onId("modal-close", "click", () => (backdrop.hidden = true));
backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.hidden = true; });

function kvGrid(container, obj) {
  container.innerHTML = "";
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (!v) return;
    const div = document.createElement("div");
    div.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
    container.appendChild(div);
  });
}

async function openModal(item) {
  document.getElementById("modal-img").src = item.photoUrl || "";
  const gal = document.getElementById("modal-gallery");
  const pics = [item.photoUrl, ...(item.extraPhotos || []).map((p) => p.url)].filter(Boolean);
  gal.innerHTML = "";
  gal.hidden = pics.length < 2;
  pics.forEach((u, i) => {
    const im = document.createElement("img");
    im.src = u.replace("/upload/", "/upload/w_160,c_limit,q_auto/");
    im.className = i === 0 ? "on" : "";
    im.addEventListener("click", () => {
      document.getElementById("modal-img").src = u;
      gal.querySelectorAll("img").forEach((x) => x.classList.toggle("on", x === im));
    });
    gal.appendChild(im);
  });
  document.getElementById("modal-article").textContent = item.article;
  document.getElementById("modal-name").textContent = item.construction?.Construction || item.costing?.["Types of Shoe"] || "Untitled";
  const vTag = document.getElementById("modal-version");
  vTag.style.display = "none";
  const sumLine = [item.costing?.Customer, item.costing?.Brand, item.costing?.["Types of Shoe"]].filter(Boolean).join(" · ");
  const sotSum = totalMinutes(item.businessSOT);
  document.getElementById("modal-summary").textContent = sumLine + (sotSum > 0 ? (sumLine ? "\n" : "") + "SOT " + sotSum.toFixed(1) + " min" : "")
    + (item.incomplete ? `\n⚠ Incomplete${item.incomplete.by ? " (saved by " + item.incomplete.by + ")" : ""}${item.incomplete.note ? ": " + item.incomplete.note : ""}` : "");

  const editBtn = document.getElementById("modal-edit-btn");
  editBtn.style.display = canUpload(currentProfile.role) ? "inline-block" : "none";
  editBtn.onclick = () => enterEditMode(item);
  const newVerBtn = document.getElementById("modal-newversion-btn");
  newVerBtn.style.display = canUpload(currentProfile.role) ? "inline-block" : "none";
  newVerBtn.onclick = () => enterNewVersionMode(item);

  // Only Master / Master God can delete.
  const delBtn = document.getElementById("modal-delete-btn");
  const delAllBtn = document.getElementById("modal-delete-all-btn");
  const mayDelete = canManageUsers(currentProfile.role);
  delBtn.hidden = !mayDelete; delAllBtn.hidden = true;
  delBtn.onclick = () => deleteSotVersion(item);
  delAllBtn.onclick = () => deleteSotArticle(item);
  const printBtn = document.getElementById("modal-print-btn"); if (printBtn) printBtn.onclick = () => printCard(item);
  const copyBtn = document.getElementById("modal-copy-btn");
  if (copyBtn) { copyBtn.style.display = canUpload(currentProfile.role) ? "inline-block" : "none"; copyBtn.onclick = () => enterCopyMode(item); }

  kvGrid(document.getElementById("modal-construction"), item.construction);
  kvGrid(document.getElementById("modal-costing"), item.costing);
  // hide sections that have nothing to show
  ["modal-construction", "modal-costing"].forEach((id) => {
    const g = document.getElementById(id);
    g.parentElement.style.display = g.children.length ? "block" : "none";
  });

  const effBlock = document.getElementById("modal-efficiency-block");
  const hasEff = item.efficiency && Object.values(item.efficiency).some((v) => v);
  effBlock.style.display = hasEff ? "block" : "none";
  if (hasEff) kvGrid(document.getElementById("modal-efficiency"), item.efficiency);

  const notesBlock = document.getElementById("modal-notes-block");
  const hasNotes = item.notes && Object.values(item.notes).some((v) => v);
  notesBlock.style.display = hasNotes ? "block" : "none";
  if (hasNotes) kvGrid(document.getElementById("modal-notes"), item.notes);

  const extraBlock = document.getElementById("modal-extra-block");
  const hasExtra = item.extra && Object.values(item.extra).some((v) => v);
  extraBlock.style.display = hasExtra ? "block" : "none";
  if (hasExtra) kvGrid(document.getElementById("modal-extra"), item.extra);

  const table = document.getElementById("modal-sot-table");
  const rows = Object.entries(item.businessSOT || {});
  table.innerHTML = `<tr><th>Operation</th><th>Minutes</th></tr>` +
    rows.map(([op, min]) => `<tr><td>${op}</td><td>${min}</td></tr>`).join("") +
    `<tr class="total"><td>Total</td><td>${totalMinutes(item.businessSOT).toFixed(1)}</td></tr>`;

  const historyBlock = document.getElementById("modal-history-block");
  const historyBox = document.getElementById("modal-history");
  const historySnap = await getDocs(query(collection(db, "sots"), where("article", "==", item.article)));
  const others = [];
  historySnap.forEach((d) => { if (d.id !== item.id) others.push({ ...d.data(), id: d.id }); });
  others.sort((a, b) => (b.year || 0) - (a.year || 0));

  delAllBtn.hidden = !(mayDelete && others.length > 0);
  delBtn.textContent = others.length > 0 ? "Delete this version" : "Delete SOT";
  if (others.length === 0) {
    historyBlock.style.display = "none";
  } else {
    historyBlock.style.display = "block";
    historyBox.innerHTML = "";
    others.forEach((o) => {
      const div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML = `<img src="${o.photoUrl || ""}" /><span class="yr">${o.year || ""}</span><span>${o.construction?.Construction || ""}</span>`;
      div.addEventListener("click", () => openModal(o));
      historyBox.appendChild(div);
    });
  }
  backdrop.hidden = false;
}

// ============================================================
// Activity tab (Master / Master God): recycle bin + audit log
// ============================================================
const fmtWhen = (ts) => { const d = ts?.toDate ? ts.toDate() : null; return d ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : ""; };
async function renderActivity() {
  if (!canManageUsers(currentProfile.role)) return;
  const binBox = document.getElementById("bin-list"), logBox = document.getElementById("log-list");
  binBox.textContent = "Loading…"; logBox.textContent = "Loading…";
  try {
    const trashSnap = await getDocs(collection(db, "trash"));
    const items = []; trashSnap.forEach((d) => items.push({ ...d.data(), tid: d.id }));
    const cutoff = Date.now() - 30 * 86400000;
    const old = items.filter((t) => (t.deletedAt?.toMillis?.() || Date.now()) < cutoff);
    for (const t of old) await deleteDoc(doc(db, "trash", t.tid)); // older than 30 days: gone for good
    const keep = items.filter((t) => !old.includes(t)).sort((a, b) => (b.deletedAt?.seconds || 0) - (a.deletedAt?.seconds || 0));
    binBox.innerHTML = keep.length ? "" : '<p class="muted">The recycle bin is empty. Deleted SOTs stay here for 30 days.</p>';
    keep.forEach((t) => {
      const row = document.createElement("div");
      row.className = "user-row";
      row.innerHTML = `<div style="display:flex;gap:12px;align-items:center;">
        ${t.photoUrl ? `<img class="master-thumb" src="${esc(t.photoUrl.replace("/upload/", "/upload/w_120,c_limit,q_auto/"))}" />` : ""}
        <div><div class="user-row-name">${esc(t.article)}${t.year ? " (" + esc(t.year) + ")" : ""}</div>
        <div class="user-row-email">${esc([t.costing?.Customer, t.costing?.Brand, t.costing?.["Types of Shoe"]].filter(Boolean).join(" · "))}<br>Deleted by ${esc(t.deletedBy || "?")} on ${esc(fmtWhen(t.deletedAt))}</div></div></div>
        <div class="user-row-actions"><button class="btn-small btn-approve">Restore</button><button class="btn-small btn-danger">Delete forever</button></div>`;
      const [restoreBtn, foreverBtn] = row.querySelectorAll("button");
      restoreBtn.addEventListener("click", async () => {
        restoreBtn.disabled = true;
        try { await restoreFromTrash(t); renderActivity(); } catch (err) { alert("Could not restore: " + err.message); restoreBtn.disabled = false; }
      });
      foreverBtn.addEventListener("click", async () => {
        if (!confirm(`Delete ${t.article} forever? This cannot be undone.`)) return;
        await deleteDoc(doc(db, "trash", t.tid)); logAudit("deleted forever", t.article); renderActivity();
      });
      binBox.appendChild(row);
    });
  } catch (err) { binBox.textContent = "Could not load the recycle bin: " + err.message; }
  try {
    const snap = await getDocs(query(collection(db, "auditLog"), orderBy("at", "desc"), limit(150)));
    const rows = []; snap.forEach((d) => rows.push(d.data()));
    logBox.innerHTML = rows.length ? "" : '<p class="muted">No activity yet.</p>';
    rows.forEach((r) => {
      const line = document.createElement("div");
      line.className = "log-line";
      line.innerHTML = `<span class="log-when">${esc(fmtWhen(r.at))}</span><span><strong>${esc(r.name || "?")}</strong> ${esc(r.action)}${r.article ? " <strong>" + esc(r.article) + "</strong>" : ""}${r.detail ? ' <span class="muted">' + esc(r.detail) + "</span>" : ""}</span>`;
      logBox.appendChild(line);
    });
  } catch (err) { logBox.textContent = "Could not load the activity log: " + err.message; }
}
async function restoreFromTrash(t) {
  const { tid, origId, deletedAt, deletedBy, ...data } = t;
  const latest = await getDocs(query(collection(db, "sots"), where("article", "==", data.article), where("isLatest", "==", true)));
  data.isLatest = latest.empty ? true : false; // never end up with two "latest" cards
  await setDoc(doc(db, "sots", origId || tid), data);
  await deleteDoc(doc(db, "trash", tid));
  await logAudit("restored", data.article);
  invalidateSotCache();
}

// ============================================================
// Users tab
// ============================================================
function watchUsers() {
  onSnapshot(collection(db, "users"), (snap) => {
    const all = [];
    snap.forEach((d) => all.push({ ...d.data(), id: d.id }));
    const visible = currentProfile.role === "master_god" ? all : all.filter((u) => u.id !== MASTER_GOD_UID);
    renderUserList(document.getElementById("pending-list"), visible.filter((u) => !u.approved), true);
    renderUserList(document.getElementById("all-users-list"), visible.filter((u) => u.approved), false);
  });
}

function watchResetRequests() {
  const box = document.getElementById("reset-box"), list = document.getElementById("reset-list");
  if (!box || !list) return;
  onSnapshot(query(collection(db, "resetRequests"), where("status", "==", "open")), (snap) => {
    const reqs = [];
    snap.forEach((d) => reqs.push({ ...d.data(), id: d.id }));
    box.hidden = reqs.length === 0;
    list.innerHTML = "";
    reqs.forEach((r) => {
      const row = document.createElement("div");
      row.className = "user-row";
      row.innerHTML = `<div><div class="user-row-name">${esc(r.name || "—")}</div><div class="user-row-email">${esc(r.email)}</div>${r.note ? `<div class="user-row-email">“${esc(r.note)}”</div>` : ""}</div><div class="user-row-actions"></div>`;
      const act = row.querySelector(".user-row-actions");
      const mk = (label, cls, fn) => { const b = document.createElement("button"); b.className = "btn-small " + cls; b.textContent = label; b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } catch (err) { alert("Failed: " + err.message); b.disabled = false; } }); act.appendChild(b); };
      mk("Send reset link", "", async () => { await sendPasswordResetEmail(auth, r.email); showToast("Reset link sent to " + r.email, null, null, 5000); });
      mk("Remove old profile", "btn-danger", async () => {
        if (!confirm(`Remove the app profile of ${r.email}?\nDo this AFTER you deleted the login in Firebase Console. The person then signs up again with the same email and you approve them.`)) throw new Error("cancelled");
        const found = await getDocs(query(collection(db, "users"), where("email", "==", r.email)));
        for (const d of found.docs) if (d.id !== MASTER_GOD_UID) await deleteDoc(doc(db, "users", d.id));
        showToast("Old profile removed. Now they can use Request access again.", null, null, 6000);
      });
      mk("Done", "btn-approve", () => updateDoc(doc(db, "resetRequests", r.id), { status: "done" }));
      list.appendChild(row);
    });
  }, () => {});
}

function renderUserList(container, users, isPendingList) {
  container.innerHTML = "";
  if (users.length === 0) { container.innerHTML = `<p class="muted" style="font-size:13px;">Nothing here.</p>`; return; }
  users.forEach((u) => {
    const row = document.createElement("div");
    row.className = "user-row";
    const isProtected = u.id === MASTER_GOD_UID;
    row.innerHTML = `
      <div><div class="user-row-name">${u.name || "—"}</div><div class="user-row-email">${u.email}</div></div>
      <div class="user-row-actions"></div>`;
    const actions = row.querySelector(".user-row-actions");
    if (isPendingList) {
      const approveBtn = document.createElement("button");
      approveBtn.className = "btn-small btn-approve";
      approveBtn.textContent = "Approve";
      approveBtn.addEventListener("click", () => updateDoc(doc(db, "users", u.id), { approved: true, role: "viewer" }));
      actions.appendChild(approveBtn);
    } else if (isProtected) {
      const badge = document.createElement("span");
      badge.className = "role-pill";
      badge.textContent = "master god — protected";
      actions.appendChild(badge);
    } else {
      const select = document.createElement("select");
      ["viewer", "editor", "master"].forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r; opt.textContent = r;
        if (u.role === r) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => updateDoc(doc(db, "users", u.id), { role: select.value }));
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-small btn-danger";
      deleteBtn.textContent = "Remove";
      deleteBtn.addEventListener("click", () => { if (confirm(`Remove ${u.name || u.email}?`)) deleteDoc(doc(db, "users", u.id)); });
      actions.appendChild(select);
      actions.appendChild(deleteBtn);
    }
    container.appendChild(row);
  });
}

// ============================================================
// Excel import
// ============================================================
// Layout of every article-card sheet (same on sheets 9..1):
//  - Row 1: "Article Name" in column A, then one article per
//    3-column block (Business SOT | Factory OT | IE SOT).
//  - Top section (until the "Time" row): customer, construction etc.
//  - Operation rows (between "Time" and "Total"): only the FIRST
//    column of each block (Business SOT) is imported.
//  - Below: efficiency rows, Special Note, Tech. Data, etc.
//  - Each article's photo is anchored at the block's first column.

// ---- PARSER START ----
const normLabel = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase().replace(/\s*\/\s*/g, "/");

// ===== Label dictionary: many spellings → one canonical field =====
const OP_ALIASES = {
  "Lamination": ["lamination"], "Cutting": ["cutting"], "Crimping": ["crimping"], "Skiving": ["skiving"],
  "UV-marking": ["uv marking", "uv-marking", "uvmarking"], "Embossed/Heat-seal": ["embossed", "emboss", "heat seal", "heat-seal", "embossed heat seal", "emboss/high frequency", "emboss/high-frequency"],
  "Seamless": ["seamless"], "Printing": ["printing", "print"], "Fusing": ["fusing"], "Loop Cutting": ["loop cutting"],
  "Heat press": ["heat press", "heat pressing"], "Heat Cut": ["heat cut"], "Brush": ["brush", "brushing"],
  "Edge color/Spray": ["edge color", "edge colour", "edge color spray", "edge colour/spray", "spray"], "Bootie": ["bootie", "bootie preparation"],
  "Pattern Sewing": ["pattern sewing"], "Embroidery": ["embroidery"], "Stitching": ["stitching"], "UV Treatment": ["uv treatment"],
  "Buffing": ["buffing"], "Stock Fitting": ["stock fitting", "stock fit", "stockfitting"], "Socks Preparation": ["socks preparation"],
  "Footbed Preparation": ["footbed preparation", "footbed"], "Insole Preparation": ["insole preparation"],
  "Sole Stitch/Preparation": ["sole stitch/preparation", "sole stitch", "sole preparation"],
  "Cemented/DIP": ["cemented/dip", "dip", "cementing"], "Packing": ["packing"],
  "Welt Attachment": ["welt attachement", "welt attachment"], "Espadrilles Preparation": ["espadrilles preparatio", "espadrilles preparation"],
  "Insole & Heel Preparation": ["insole & heel preparat", "insole and heel preparation", "insole & heel preparation"],
  "WP Gluing": ["wp gluing", "wp glueing"], "Pre Stitching": ["pre stitching", "pre-stitching"], "Hand Stitch": ["hand stitch", "hand stitching"],
};
const OPS = {};
BUSINESS_SOT_OPERATIONS.forEach((op) => { OPS[normLabel(op)] = op; });
Object.entries(OP_ALIASES).forEach(([op, list]) => list.forEach((l) => { OPS[normLabel(l)] = op; }));
function resolveOp(label) {
  const n = normLabel(label);
  if (OPS[n]) return OPS[n];
  if (n.startsWith("sole stitch")) return "Sole Stitch/Preparation"; // "only sole" / "with upper" are summed
  return null;
}

// info fields: label → [group, key]
const FIELDS = {};
const addField = (labels, group, key) => labels.forEach((l) => { FIELDS[normLabel(l)] = [group, key]; });
addField(["customer", "buyer"], "costing", "Customer");
addField(["brand"], "costing", "Brand");
addField(["category", "types of shoe", "type of shoe"], "costing", "Types of Shoe");
addField(["ordered yet"], "costing", "Ordered Yet");
addField(["stage"], "costing", "Stage");
addField(["version"], "costing", "Version");
addField(["received date", "receive date", "date received"], "costing", "Received Date");
addField(["delivery date"], "costing", "Delivery Date");
addField(["size range", "size"], "costing", "Size Range");
addField(["gender"], "costing", "Gender");
addField(["initial order qty", "order qty", "qty", "order quantity"], "costing", "Order Qty");
addField(["order status"], "costing", "Order Status");
addField(["upper material", "upper"], "construction", "Upper Material");
addField(["safety toe"], "construction", "Safety Toe");
addField(["wp/nwp"], "construction", "WP/NWP");
addField(["cemented/dip"], "construction", "Cemented/DIP");
addField(["construction"], "construction", "Construction");
addField(["outsole", "sole"], "construction", "Outsole");
addField(["similar existing"], "extra", "Similar Existing");
addField(["similar variation"], "extra", "Similar Variation");
addField(["shoe type"], "extra", "Shoe Type");
const DATE_KEYS = new Set(["Received Date", "Delivery Date"]);
const NOTE_KEYS = {
  "special note:": "Special Note", "special note": "Special Note", "tech. data": "Tech. Data", "tech data": "Tech. Data",
  "physical sample": "Physical Sample", "sample autopsy": "Sample Autopsy", "recommendation": "Recommendation",
};
const IGNORE_LABELS = new Set(["picture", "pic", "image", "photo", "sl. no", "sl no", "sl.", "sl", "s/l.", "s/l", "sr", "sr no", "sr.", "no", "no.", "serial", "serial no",
  "total", "time", "sot", "factory ot", "ie sot", "business sot"]);
const ARTICLE_LABELS = ["article", "article name", "article no", "article number", "article no.", "model", "model no", "style", "style no"];

function efficiencyKey(label) {
  if (label.startsWith("assembly owe")) return "Assembly OWE";
  if (label.startsWith("assembly manpower")) return "Assembly Manpower (D)";
  if (label.startsWith("target output/hr") && label.includes("assemb")) return "Target Output/HR Avg (Assembly)";
  if (label === "avg hourly output") return "Target Output/HR Avg (Assembly)";
  if (label.startsWith("highest possible")) return "Highest Possible Output/HR";
  if (label.startsWith("stitching owe")) return "Stitching OWE";
  if (label.startsWith("stitching manpower")) return "Stitching Manpower (D)";
  if (label.startsWith("target output/hr") && label.includes("sewing")) return "Target Output/HR Avg (Sewing)";
  return null;
}
// → {group:"ignore"} | {group, key} | null (unknown)
function resolveField(label) {
  const n = normLabel(label);
  if (IGNORE_LABELS.has(n)) return { group: "ignore" };
  if (FIELDS[n]) return { group: FIELDS[n][0], key: FIELDS[n][1] };
  const eff = efficiencyKey(n);
  if (eff) return { group: "efficiency", key: eff };
  if (NOTE_KEYS[n]) return { group: "notes", key: NOTE_KEYS[n] };
  return null;
}

function cleanCell(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number") return Math.round(v * 100) / 100;
  return String(v).trim();
}
// Cell value; cells formatted as % in Excel come back as "75%" (not 0.75); Excel dates → yyyy-mm-dd.
function cellOut(XLSX, sheet, range, rows, r, c, key) {
  const raw = rows[r] ? rows[r][c] : "";
  const cell = sheet[XLSX.utils.encode_cell({ r: r + range.s.r, c: c + range.s.c })];
  if (cell && typeof cell.v === "number" && typeof cell.z === "string" && cell.z.includes("%")) return `${Math.round(cell.v * 10000) / 100}%`;
  if (DATE_KEYS.has(key) && typeof raw === "number") { const d = XLSX.SSF.parse_date_code(raw); return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`; }
  return raw;
}
// numbers typed as text ("3.5", or a typo like "1..6") count as numbers
function asNumber(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.{1,2}\d+)?\s*$/.test(v)) return Number(v.replace(/\.{2,}/g, "."));
  return null;
}
const isBlank = (v) => v === "" || v === undefined || v === null || (typeof v === "string" && !v.trim());

function newRow(article) {
  return { article, construction: {}, costing: {}, businessSOT: {}, efficiency: {}, notes: {}, extra: {}, unk: {}, unkRegion: {} };
}
// puts a recognised value in the right bucket
function putField(row, group, key, value) {
  if (group === "ignore" || isBlank(value)) return;
  const v = cleanCell(value);
  if (v === "") return;
  if (group === "notes" || group === "extra" || group === "construction" || group === "costing" || group === "efficiency") row[group][key] = v;
}
// remembers an unrecognised label + value (decided later in the review step)
function putUnknown(ctx, row, label, region, value) {
  if (isBlank(value) || value === 0) return;
  if (typeof value === "string" && asNumber(value) !== null) value = asNumber(value);
  const n = normLabel(label);
  row.unk[n] = value;
  row.unkRegion[n] = region;
  let u = ctx.unknown.get(n);
  if (!u) { u = { label: String(label).trim(), region, count: 0, samples: [], numeric: true }; ctx.unknown.set(n, u); }
  u.count++;
  if (typeof value !== "number") u.numeric = false;
  const sv = String(typeof value === "number" ? Math.round(value * 100) / 100 : value).trim().slice(0, 40);
  if (u.samples.length < 3 && !u.samples.includes(sv)) u.samples.push(sv);
}

// ===== Layout 1: article cards (article names across row 1, labels down column A) =====
function parseCardSheet(XLSX, sheet, ctx) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  if (!rows[0] || !ARTICLE_LABELS.includes(normLabel(rows[0][0]))) return [];
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 } };

  let timeRow = -1, totalRow = -1;
  rows.forEach((r, i) => {
    const l = normLabel(r[0]);
    if (l === "time" && timeRow < 0) timeRow = i;
    if (l === "total" && timeRow >= 0 && totalRow < 0) totalRow = i;
  });
  if (timeRow < 0) timeRow = 24;
  if (totalRow < 0) totalRow = timeRow + 28;

  const out = [];
  const header = rows[0];
  for (let col = 1; col < header.length; col++) {
    const article = String(header[col] ?? "").trim();
    if (!article) continue;
    const row = newRow(article);
    row.col = col;
    const get = (r, key) => cellOut(XLSX, sheet, range, rows, r, col, key);
    const seen = new Set();

    for (let r = 1; r < rows.length; r++) {
      const label = String(rows[r][0] ?? "").trim();
      if (!label) continue;
      const n = normLabel(label);

      if (r > timeRow && r < totalRow) {                       // ----- operations (Business SOT = first column of the block)
        const op = resolveOp(label);
        const v = get(r);
        if (op) { ctx.known.add(n); const nv = asNumber(v); if (nv !== null && nv > 0) row.businessSOT[op] = Math.round(((row.businessSOT[op] || 0) + nv) * 100) / 100; }
        else putUnknown(ctx, row, label, "op", v);
        continue;
      }
      if (r === timeRow || r === totalRow) continue;

      const f = resolveField(label);                             // ----- everything else
      if (!f) { putUnknown(ctx, row, label, "field", get(r)); continue; }
      ctx.known.add(n);
      if (f.group === "ignore" || seen.has(n)) continue;
      seen.add(n);
      if (f.group === "notes") {
        // a note's text can span this row and the rows below it (blank label column)
        const parts = [];
        for (let k = r; k < rows.length; k++) {
          if (k > r && String(rows[k][0] ?? "").trim()) break;
          const v = cleanCell(get(k));
          if (v !== "") parts.push(String(v));
        }
        if (parts.length) row.notes[f.key] = parts.join("\n");
      } else putField(row, f.group, f.key, get(r, f.key));
    }
    row.construction.Construction = row.construction.Construction || "";
    out.push(row);
  }
  return out;
}

// ===== Layout 2: table (one row per article, labels across a header row) =====
function parseTableSheet(XLSX, sheet, ctx) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 } };
  let h = -1, cArt = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const labels = rows[i].map(normLabel);
    const a = labels.findIndex((l) => ARTICLE_LABELS.includes(l));
    const recognised = labels.filter((l) => l && (resolveField(l) || resolveOp(l))).length;
    if (a >= 0 && recognised >= 4) { h = i; cArt = a; break; }
  }
  if (h < 0) return [];
  const heads = rows[h];
  const labels = heads.map(normLabel);
  let firstOp = labels.findIndex((l) => l && resolveOp(l) && !resolveField(l));
  if (firstOp < 0) firstOp = labels.indexOf("sot") + 1;
  const cSL = labels.findIndex((l) => ["s/l.", "s/l", "sl", "sl.", "sl no", "sl. no", "sr", "sr no", "no", "no.", "serial no"].includes(l));
  const text = (v) => String(v ?? "").trim();

  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const row = newRow(text(r[cArt]));
    const sl = cSL >= 0 ? text(r[cSL]) : "";
    for (let c = 0; c < heads.length; c++) {
      const label = text(heads[c]);
      if (!label || c === cArt) continue;
      const n = labels[c];
      const v = cellOut(XLSX, sheet, range, rows, i, c);
      if (c >= firstOp) {
        const op = resolveOp(label);
        if (op) { ctx.known.add(n); const nv = asNumber(v); if (nv !== null && nv > 0) row.businessSOT[op] = Math.round(((row.businessSOT[op] || 0) + nv) * 100) / 100; }
        else if (!IGNORE_LABELS.has(n)) putUnknown(ctx, row, label, "op", v);
      } else {
        const f = resolveField(label);
        if (!f) { putUnknown(ctx, row, label, "field", v); continue; }
        ctx.known.add(n);
        if (f.group === "ignore") continue;
        const val = cellOut(XLSX, sheet, range, rows, i, c, f.key);
        putField(row, f.group, f.key, typeof val === "string" ? val.trim().replace(/^none$/i, "") : val);
      }
    }
    const hasData = row.article || Object.keys(row.costing).length || Object.keys(row.businessSOT).length;
    if (!hasData) continue;
    if (!row.article) {
      row.autoNamed = true;
      const parts = [row.costing.Customer, row.costing.Brand, row.costing["Types of Shoe"]].filter(Boolean).filter((v, i, arr) => arr.findIndex((w) => String(w).trim().toLowerCase() === String(v).trim().toLowerCase()) === i).join("-").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
      row.article = `${parts || "SL"}-${sl || i + range.s.r + 1}`;
    }
    row.construction.Construction = row.construction.Construction || "";
    row.importKey = `${sl || "r" + (i + range.s.r + 1)}|${row.article}`;
    row.anchorRow = i + range.s.r; // 0-based sheet row → used to find the photo
    out.push(row);
  }
  return out;
}

// ===== Decisions for labels the app does not know yet =====
// decision: "keep" | "skip" | "op:<Operation>" | "field:<group>|<key>"
function tidyName(label) {
  return String(label).trim().toLowerCase().replace(/(^|[\s(\/&])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/\bUv\b/g, "UV").replace(/\bWp\b/g, "WP");
}
function applyDecisions(rows, decisions) {
  const stats = { kept: new Set(), mapped: new Set(), skipped: new Set() };
  rows.forEach((row) => {
    Object.entries(row.unk || {}).forEach(([n, value]) => {
      const dec = decisions[n] || "keep";
      const num = typeof value === "number" ? Math.round(value * 100) / 100 : null;
      if (dec === "skip") { stats.skipped.add(n); return; }
      if (dec.startsWith("op:")) {
        const op = dec.slice(3);
        if (num > 0) row.businessSOT[op] = Math.round(((row.businessSOT[op] || 0) + num) * 100) / 100;
        stats.mapped.add(n); return;
      }
      if (dec.startsWith("field:")) {
        const [group, key] = dec.slice(6).split("|");
        putField(row, group, key, value);
        stats.mapped.add(n); return;
      }
      // keep as a new item
      const name = tidyName(n);
      if (num > 0 && row.unkRegion[n] === "op") row.businessSOT[name] = Math.round(((row.businessSOT[name] || 0) + num) * 100) / 100;
      else row.extra[name] = typeof value === "number" ? num : String(value).trim();
      stats.kept.add(n);
    });
  });
  return stats;
}

// Maps sheet name -> [{col, row, dataUrl}] using the drawing anchors,
// so each photo is matched to its article by position (not by order).
async function extractSheetImages(zip) {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const parse = async (path) => {
    const f = zip.file(path);
    return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null;
  };
  const rels = (doc) => {
    const m = {};
    if (doc) for (const el of doc.getElementsByTagName("Relationship")) m[el.getAttribute("Id")] = el;
    return m;
  };
  const wb = await parse("xl/workbook.xml");
  const wbRels = rels(await parse("xl/_rels/workbook.xml.rels"));
  const result = {};
  for (const sh of wb.getElementsByTagName("sheet")) {
    if (["hidden", "veryHidden"].includes(sh.getAttribute("state"))) continue; // skip hidden sheets
    const name = sh.getAttribute("name");
    const target = wbRels[sh.getAttributeNS(REL, "id")]?.getAttribute("Target");
    if (!target) continue;
    const sheetFile = target.replace(/^\/?(xl\/)?/, "");
    const sheetRels = rels(await parse(`xl/worksheets/_rels/${sheetFile.split("/").pop()}.rels`));
    const drawingRel = Object.values(sheetRels).find((r) => /\/drawing$/.test(r.getAttribute("Type")));
    if (!drawingRel) continue;
    const drawingFile = drawingRel.getAttribute("Target").split("/").pop();
    const drawing = await parse(`xl/drawings/${drawingFile}`);
    const dRels = rels(await parse(`xl/drawings/_rels/${drawingFile}.rels`));
    const list = [];
    for (const anchor of drawing.documentElement.children) {
      const from = [...anchor.children].find((c) => c.localName === "from");
      const blip = [...anchor.getElementsByTagName("*")].find((e) => e.localName === "blip");
      if (!from || !blip) continue;
      const rid = blip.getAttributeNS(REL, "embed");
      const mediaTarget = dRels[rid]?.getAttribute("Target");
      if (!mediaTarget) continue;
      const mediaPath = "xl/media/" + mediaTarget.split("/").pop();
      const ext = mediaPath.split(".").pop().toLowerCase();
      if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) continue; // browsers can't show emf/wmf
      const file = zip.file(mediaPath);
      if (!file) continue;
      const col = Number([...from.children].find((c) => c.localName === "col").textContent);
      const row = Number([...from.children].find((c) => c.localName === "row").textContent);
      list.push({ col, row, ext, base64: await file.async("base64") });
    }
    result[name] = list;
  }
  return result;
}

function pickImageForArticle(images, col) {
  // photo is anchored at the block's first column, near the top of the card
  const near = (images || []).filter((im) => im.row <= 22 && im.col >= col && im.col <= col + 2);
  if (!near.length) return null;
  near.sort((a, b) => a.col - b.col || a.row - b.row);
  const im = near[0];
  return `data:image/${im.ext === "jpg" ? "jpeg" : im.ext};base64,${im.base64}`;
}

// Reads sheet names/states from workbook.xml, so hidden sheets can be skipped.
async function listSheets(zip) {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const parse = async (path) => {
    const f = zip.file(path);
    return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null;
  };
  const wb = await parse("xl/workbook.xml");
  const relDoc = await parse("xl/_rels/workbook.xml.rels");
  const targets = {};
  if (relDoc) for (const el of relDoc.getElementsByTagName("Relationship")) targets[el.getAttribute("Id")] = el.getAttribute("Target");
  return [...wb.getElementsByTagName("sheet")].map((sh) => {
    const t = targets[sh.getAttributeNS(REL, "id")] || "";
    return {
      name: sh.getAttribute("name"),
      hidden: ["hidden", "veryHidden"].includes(sh.getAttribute("state")),
      path: "xl/" + t.replace(/^\/?(xl\/)?/, ""),
    };
  });
}

// SheetJS's own zip reader breaks on some files ("Bad compressed size").
// JSZip is more forgiving, so we open the file with JSZip and re-pack only
// what's needed (no photos, no hidden sheets) into a clean zip for SheetJS.
async function readWorkbookRobust(XLSX, JSZip, zip, sheets) {
  const skip = new Set();
  sheets.filter((s) => s.hidden).forEach((s) => {
    skip.add(s.path);
    skip.add(s.path.replace("worksheets/", "worksheets/_rels/") + ".rels");
  });
  const clean = new JSZip();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (skip.has(path)) continue;
    if (/^xl\/(media|drawings|printerSettings|richData|embeddings)\//.test(path)) continue;
    clean.file(path, await entry.async("uint8array"));
  }
  const out = await clean.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return XLSX.read(out, { type: "array", cellNF: true, sheets: sheets.filter((s) => !s.hidden).map((s) => s.name) });
}


function pickImageForRow(images, row0) {
  const im = (images || []).find((x) => x.row === row0 && x.col >= 3 && x.col <= 7);
  return im ? `data:image/${im.ext === "jpg" ? "jpeg" : im.ext};base64,${im.base64}` : null;
}
// ---- PARSER END ----

// ---- Review step: labels the app does not know yet --------------------------------
const MAP_TARGET_FIELDS = [
  ["costing", "Customer"], ["costing", "Brand"], ["costing", "Types of Shoe"], ["costing", "Stage"], ["costing", "Size Range"], ["costing", "Gender"],
  ["costing", "Order Qty"], ["costing", "Order Status"], ["construction", "Construction"], ["construction", "Outsole"], ["construction", "Upper Material"],
  ["efficiency", "Assembly OWE"], ["efficiency", "Assembly Manpower (D)"], ["efficiency", "Target Output/HR Avg (Assembly)"], ["efficiency", "Highest Possible Output/HR"],
  ["efficiency", "Stitching OWE"], ["efficiency", "Stitching Manpower (D)"], ["efficiency", "Target Output/HR Avg (Sewing)"],
  ["notes", "Special Note"], ["notes", "Tech. Data"], ["notes", "Physical Sample"], ["notes", "Sample Autopsy"], ["notes", "Recommendation"],
];
const decKey = (n) => encodeURIComponent(n).replace(/\./g, "%2E");
async function loadSavedDecisions() {
  try {
    const snap = await getDoc(doc(db, "config", "importMap"));
    const raw = snap.exists() ? snap.data().decisions || {} : {};
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [decodeURIComponent(k), v]));
  } catch (_) { return {}; }
}
async function saveDecisions(newOnes) {
  if (!Object.keys(newOnes).length) return;
  try {
    await setDoc(doc(db, "config", "importMap"), { decisions: Object.fromEntries(Object.entries(newOnes).map(([k, v]) => [decKey(k), v])) }, { merge: true });
  } catch (err) { console.warn("Could not save import answers:", err); }
}

// Shows the unknown labels and resolves with {label: decision}. Nothing is imported before the user answers.
function askAboutNewLabels(unknownList) {
  return new Promise((resolve) => {
    const box = document.getElementById("import-review");
    box.innerHTML = `<p class="section-label">New labels found in this file</p>
      <p class="muted" style="font-size:13px;margin:0 0 12px;">These names are not in the app yet. For each one choose: <strong>Keep</strong> (it becomes a new item on every card that has it), <strong>Map</strong> to something the app already has, or <strong>Skip</strong>. Your answers are remembered for the next file.</p>`;
    const rows = [];
    unknownList.forEach((u) => {
      const row = document.createElement("div");
      row.className = "review-row";
      const sel = document.createElement("select");
      const opt = (v, t, parent) => { const o = document.createElement("option"); o.value = v; o.textContent = t; (parent || sel).appendChild(o); };
      opt("keep", u.region === "op" && u.numeric ? "Keep as a new operation (minutes)" : "Keep as a new item (shown under “Other details”)");
      opt("skip", "Skip — do not import");
      const g1 = document.createElement("optgroup"); g1.label = "Map to a Business SOT operation";
      BUSINESS_SOT_OPERATIONS.forEach((op) => opt("op:" + op, op, g1)); sel.appendChild(g1);
      const g2 = document.createElement("optgroup"); g2.label = "Map to an info field";
      MAP_TARGET_FIELDS.forEach(([g, k]) => opt(`field:${g}|${k}`, k, g2)); sel.appendChild(g2);
      row.innerHTML = `<div><strong>${esc(u.label)}</strong><div class="muted" style="font-size:12px;">${u.count} row${u.count === 1 ? "" : "s"} have a value${u.samples.length ? ", e.g. " + esc(u.samples.join(", ")) : ""} · ${u.region === "op" ? "among the operations" : "among the info fields"}</div></div>`;
      row.appendChild(sel);
      box.appendChild(row);
      rows.push([u.n, sel]);
    });
    const go = document.createElement("button");
    go.className = "btn btn-primary"; go.type = "button"; go.style.marginTop = "12px"; go.textContent = "Apply and continue";
    go.onclick = () => {
      box.hidden = true; box.innerHTML = "";
      resolve(Object.fromEntries(rows.map(([n, sel]) => [n, sel.value])));
    };
    box.appendChild(go);
    box.hidden = false;
  });
}

let importQueue = []; // [{article, construction, costing, businessSOT, efficiency, notes, extra, imageDataUrl}]

onId("import-file", "change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusBox = document.getElementById("import-status");
  statusBox.hidden = false; statusBox.textContent = "Reading workbook…";
  document.getElementById("import-review").hidden = true;
  document.getElementById("import-preview").innerHTML = "";
  importPage = 1; importRowStatus.clear();
  document.getElementById("import-confirm-btn").style.display = "none";

  try {
    const [{ default: JSZip }, XLSX] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm"),
      import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"),
    ]);
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const sheets = await listSheets(zip);
    const workbook = await readWorkbookRobust(XLSX, JSZip, zip, sheets);

    // Photos are optional: if they can't be read, still import the data.
    let imagesBySheet = {};
    try {
      statusBox.textContent = "Reading photos…";
      imagesBySheet = await extractSheetImages(zip);
    } catch (imgErr) {
      console.warn("Could not read photos from workbook:", imgErr);
    }

    // 1) read every visible sheet; each layout is recognised automatically
    const ctx = { known: new Set(), unknown: new Map() };
    const unrecognised = [];
    importQueue = [];
    for (const { name: sheetName, hidden } of sheets) {
      if (hidden || !workbook.Sheets[sheetName]) continue; // never read hidden sheets
      const sheet = workbook.Sheets[sheetName];
      const cards = parseCardSheet(XLSX, sheet, ctx);
      if (cards.length) { cards.forEach((a) => importQueue.push({ ...a, imageDataUrl: pickImageForArticle(imagesBySheet[sheetName], a.col) })); continue; }
      const table = parseTableSheet(XLSX, sheet, ctx);
      if (table.length) { table.forEach((a) => importQueue.push({ ...a, imageDataUrl: pickImageForRow(imagesBySheet[sheetName], a.anchorRow) })); continue; }
      if (sheet["!ref"] && !(sheet["A1"] && ARTICLE_LABELS.includes(normLabel(sheet["A1"].v)))) unrecognised.push(sheetName);
    }

    // 2) labels the app has never seen: use remembered answers, ask about the rest
    const saved = await loadSavedDecisions();
    const unknownList = [...ctx.unknown.entries()].map(([n, u]) => ({ ...u, n }));
    const toAsk = unknownList.filter((u) => !saved[u.n]);
    let answers = {};
    if (toAsk.length) {
      statusBox.textContent = `${ctx.known.size} labels recognised, ${toAsk.length} new — please decide below.`;
      answers = await askAboutNewLabels(toAsk);
      await saveDecisions(answers);
    }
    const decisions = { ...saved, ...answers };
    const stats = applyDecisions(importQueue, decisions);

    // 3) rows imported in an earlier run are skipped (table layout)
    if (importQueue.some((r) => r.importKey)) {
      statusBox.textContent = "Checking which rows were imported before…";
      const done = new Set();
      (await getDocs(collection(db, "sots"))).forEach((d) => { if (d.data().importKey) done.add(d.data().importKey); });
      importQueue.forEach((r) => { if (r.importKey && done.has(r.importKey)) r.skip = true; });
    }
    const withPhoto = importQueue.filter((r) => r.imageDataUrl).length;
    const skipped = importQueue.filter((r) => r.skip).length;
    const auto = importQueue.filter((r) => r.autoNamed).length;
    const dupNames = importQueue.length - new Set(importQueue.map((r) => r.article)).size;
    // articles already in the database (and not skipped) will be saved as a NEW VERSION of the existing card
    const existing = new Set((await getAllLatestSots()).map((d) => String(d.article).trim().toLowerCase()));
    const willVersion = importQueue.filter((r) => !r.skip && existing.has(String(r.article).trim().toLowerCase())).length;
    statusBox.textContent = `Found ${importQueue.length} entr${importQueue.length === 1 ? "y" : "ies"} (${withPhoto} with photo). ` +
      `Labels: ${ctx.known.size} matched automatically, ${stats.kept.size} new kept, ${stats.mapped.size} mapped, ${stats.skipped.size} skipped.` +
      (auto ? ` ${auto} had no article number and got an automatic name.` : "") +
      (dupNames ? ` ⚠ ${dupNames} repeat an article number inside this file (saved as versions of each other).` : "") +
      (willVersion ? ` ⚠ ${willVersion} article(s) already exist in the database and will be saved as a NEW VERSION (the old card stays as history).` : "") +
      (skipped ? ` ${skipped} already imported earlier (will be skipped).` : "") +
      (unrecognised.length ? ` Not recognised and left out: sheet ${unrecognised.map((n) => "“" + n + "”").join(", ")} (no article header found).` : "") +
      " Review below, then confirm.";
    renderImportPreview();
    document.getElementById("import-confirm-btn").style.display = importQueue.length ? "inline-block" : "none";
  } catch (err) {
    statusBox.textContent = "Couldn't read that file: " + err.message;
  }
});

const IMPORT_PAGE_SIZE = 25;
let importPage = 1;
const importRowStatus = new Map(); // row index -> live status text (kept while you flip pages)
function renderImportPreview() {
  const box = document.getElementById("import-preview");
  box.innerHTML = "";
  const pages = Math.max(1, Math.ceil(importQueue.length / IMPORT_PAGE_SIZE));
  if (importPage > pages) importPage = pages;
  const off = (importPage - 1) * IMPORT_PAGE_SIZE;
  const pagerTop = document.createElement("div"); pagerTop.className = "pager";
  box.appendChild(pagerTop);
  importQueue.slice(off, off + IMPORT_PAGE_SIZE).forEach((row, k) => {
    const i = off + k;
    const ops = Object.keys(row.businessSOT || {}).length;
    const total = Object.values(row.businessSOT || {}).reduce((a, b) => a + Number(b), 0);
    const effCount = Object.keys(row.efficiency || {}).length;
    const noteCount = Object.keys(row.notes || {}).length;
    const line1 = [row.construction.Construction, row.construction.Outsole, row.costing["Types of Shoe"], row.costing.Customer, row.costing.Brand].filter(Boolean).join(" · ") || "—";
    const line2 = `Business SOT: ${ops} ops, total ${Math.round(total * 100) / 100} min · Efficiency: ${effCount}/7 · Notes: ${noteCount}`;
    const div = document.createElement("div");
    div.className = "import-row";
    div.innerHTML = `
      ${row.imageDataUrl ? `<img src="${row.imageDataUrl}" />` : `<div class="muted" style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;font-size:10px;border:1px dashed #cdbfa8;border-radius:6px;">no photo</div>`}
      <div><strong>${esc(row.article)}</strong>${row.autoNamed ? ' <span class="muted" style="font-size:11px;">(auto name)</span>' : ""}<div class="muted" style="font-size:12px;">${esc(line1)}</div><div class="muted" style="font-size:12px;">${line2}</div></div>
      <span class="status" id="import-status-${i}">${esc(importRowStatus.get(i) || (row.skip ? "already imported" : "ready"))}</span>`;
    div.querySelector("strong").insertAdjacentHTML("beforebegin", `<span class="muted" style="font-size:12px;">#${i + 1} </span>`);
    box.appendChild(div);
  });
  const pagerBottom = document.createElement("div"); pagerBottom.className = "pager";
  box.appendChild(pagerBottom);
  const change = (n) => { importPage = n; renderImportPreview(); };
  renderPager(pagerTop, importQueue.length, IMPORT_PAGE_SIZE, importPage, change);
  renderPager(pagerBottom, importQueue.length, IMPORT_PAGE_SIZE, importPage, change);
}

// Photo upload + AI embedding for up to 3 rows at the same time; saving to the database
// happens strictly in file order (so repeated article numbers become versions in order).
onId("import-confirm-btn", "click", async () => {
  const btn = document.getElementById("import-confirm-btn");
  const statusBox = document.getElementById("import-status");
  btn.disabled = true;
  const setRow = (i, t) => { importRowStatus.set(i, t); const el = document.getElementById(`import-status-${i}`); if (el) el.textContent = t; };
  const todo = importQueue.map((row, i) => ({ row, i })).filter((x) => !x.row.skip);

  // progress bar + time left
  let prog = document.getElementById("import-progress");
  if (!prog) {
    prog = document.createElement("div"); prog.id = "import-progress"; prog.className = "progress";
    prog.innerHTML = `<div class="pbar"><i></i></div><div class="ptext"></div>`;
    statusBox.after(prog);
  }
  prog.hidden = false;
  document.getElementById("import-failed-btn")?.remove();
  const startedAt = Date.now();
  const fmt = (sec) => (sec >= 90 ? Math.round(sec / 60) + " min" : Math.max(1, Math.round(sec)) + " sec");
  const paint = (done, failedN) => {
    const pct = todo.length ? Math.round((done / todo.length) * 100) : 100;
    prog.querySelector("i").style.width = pct + "%";
    let eta = "";
    if (done > 0 && done < todo.length) eta = ` · about ${fmt(((Date.now() - startedAt) / done) * (todo.length - done) / 1000)} left`;
    prog.querySelector(".ptext").textContent = `${pct}% — ${done} of ${todo.length} rows${failedN ? `, ${failedN} failed` : ""}${eta}`;
  };
  paint(0, 0);
  const warnLeave = (e) => { e.preventDefault(); e.returnValue = ""; };
  window.addEventListener("beforeunload", warnLeave);

  let running = 0; const waiting = [];
  const limit = async (fn) => {
    while (running >= 3) await new Promise((r) => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  };
  const prep = new Map();
  todo.forEach(({ row, i }) => {
    prep.set(i, limit(async () => {
      setRow(i, "uploading photo…");
      const photoUrl = row.imageDataUrl ? await uploadToCloudinary(dataUrlToFile(row.imageDataUrl, `${row.article}.jpg`)) : "";
      setRow(i, "embedding…");
      const embedding = photoUrl ? await embedImage(photoUrl) : new Array(512).fill(0);
      return { photoUrl, embedding };
    }));
    prep.get(i).catch(() => {}); // errors are handled below, in order
  });

  let ok = 0, failed = 0; const failures = [];
  for (let n = 0; n < todo.length; n++) {
    const { row, i } = todo[n];
    statusBox.textContent = `Importing… keep this tab open.`;
    try {
      const { photoUrl, embedding } = await prep.get(i);
      setRow(i, "saving…");
      const isNewVersion = await saveSotWithVersioning({
        article: row.article,
        construction: row.construction,
        costing: row.costing,
        businessSOT: row.businessSOT || {},
        efficiency: row.efficiency || {},
        notes: row.notes || {},
        extra: row.extra || {},
        ...(row.importKey ? { importKey: row.importKey } : {}),
        photoUrl,
        embedding,
      });
      setRow(i, isNewVersion ? "saved (new version)" : "saved");
      ok++;
    } catch (err) {
      setRow(i, "failed: " + err.message);
      failures.push({ article: row.article, error: err.message });
      failed++;
    }
    paint(n + 1, failed);
  }
  window.removeEventListener("beforeunload", warnLeave);
  btn.disabled = false;
  if (ok) logAudit("imported", "", `${ok} saved, ${failed} failed`);
  statusBox.textContent = `Import finished: ${ok} saved` + (failed ? `, ${failed} failed (upload the same file again — rows already saved are skipped)` : "") + ".";
  if (failures.length) {
    const fb = document.createElement("button");
    fb.id = "import-failed-btn"; fb.type = "button"; fb.className = "btn-small"; fb.style.marginLeft = "10px";
    fb.textContent = "Download failed rows (CSV)";
    fb.addEventListener("click", () => {
      const csv = "Article,Error\n" + failures.map((f) => `"${String(f.article).replace(/"/g, '""')}","${String(f.error).replace(/"/g, '""')}"`).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "import-failed-rows.csv";
      document.body.appendChild(a); a.click(); a.remove();
    });
    prog.querySelector(".ptext").appendChild(fb);
  }
  invalidateSotCache();
});

// Blank template (same columns the importer reads)
onId("import-template", "click", async () => {
  try {
    const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const X = XLSX.default || XLSX;
    const head = ["S/L", "CUSTOMER", "BRAND", "CATEGORY", "ARTICLE", "SOT", ...BUSINESS_SOT_OPERATIONS.map((o) => o.toUpperCase())];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([head, [1, "Customer name", "Brand name", "Category", "ART-001", "", ...BUSINESS_SOT_OPERATIONS.map(() => "")]]), "SOT");
    X.writeFile(wb, "SOT-import-template.xlsx");
  } catch (err) { alert("Could not create the template: " + err.message); }
});

function dataUrlToFile(dataUrl, filename) {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*);base64/)[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}

// ---- end of app.js (if you can read this line at the very bottom of the file on GitHub, the upload is complete) ----
