import { auth, db, MASTER_GOD_UID } from "./firebase-config.js";
import { cloudName as CLOUDINARY_CLOUD_NAME, uploadPreset as CLOUDINARY_UPLOAD_PRESET } from "./cloudinary-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, updateProfile,
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
const BUILD = "ai-pro-v12";
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
  if (canManageUsers(currentProfile.role)) watchUsers();
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
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    // pick up other people's changes: drop a cache older than 20 seconds when opening a list tab
    if (["tab-master", "tab-search", "tab-match"].includes(btn.dataset.tab) && Date.now() - sotCacheAt > 20000) sotCache = null;
    if (btn.dataset.tab === "tab-master") renderMaster().catch(() => {});
    if (btn.dataset.tab === "tab-activity") renderActivity();
    if (btn.dataset.tab === "tab-insights") renderInsights().catch(() => {});
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
        <span class="result-article">${item.article || "—"}</span>
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
  for (let i = 0; i < docs.length; i += 200) {
    const b = writeBatch(db);
    docs.slice(i, i + 200).forEach((d) => {
      const { id, ...data } = d;
      b.set(doc(collection(db, "trash")), { ...data, origId: id, deletedAt: serverTimestamp(), deletedBy: who });
      b.delete(doc(db, "sots", id));
    });
    await b.commit();
  }
}
// After deleting, every article that still has versions must have exactly one latest.
async function fixLatestFlags(remaining, articles) {
  const byArticle = new Map();
  remaining.forEach((d) => { if (articles.has(d.article)) { if (!byArticle.has(d.article)) byArticle.set(d.article, []); byArticle.get(d.article).push(d); } });
  const b = writeBatch(db); let n = 0;
  byArticle.forEach((list) => {
    if (list.some((d) => d.isLatest)) return;
    list.sort((a, b2) => (b2.year || 0) - (a.year || 0) || (b2.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    b.update(doc(db, "sots", list[0].id), { isLatest: true }); n++;
  });
  if (n) await b.commit();
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
const master = { sortKey: "article", dir: 1, shown: 100, selected: new Set(), filtered: [] };
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
  const rows = items.slice(0, master.shown);
  const body = rows.map((it, i) => `<tr data-i="${i}" class="${master.selected.has(it.id) ? "picked" : ""}">
    <td class="chk-col"><input type="checkbox" class="row-chk" ${master.selected.has(it.id) ? "checked" : ""} aria-label="Select ${esc(it.article)}" /></td>
    <td>${i + 1}</td><td>${esc(getters.customer(it))}</td><td>${esc(brandOf(it))}</td><td>${esc(categoryOf(it))}</td>
    <td><strong>${esc(it.article)}</strong></td>
    <td>${it.photoUrl ? `<img class="master-thumb" loading="lazy" src="${esc(it.photoUrl.replace("/upload/", "/upload/w_120,c_limit,q_auto/"))}" />` : ""}</td>
    <td>${totalMinutes(it.businessSOT) > 0 ? totalMinutes(it.businessSOT).toFixed(1) : ""}</td>
    ${opCols.map((op) => `<td class="op-col">${Number(it.businessSOT?.[op]) > 0 ? it.businessSOT[op] : ""}</td>`).join("")}</tr>`).join("");
  const table = document.getElementById("master-table");
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  table.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort; master.dir = master.sortKey === k ? -master.dir : 1; master.sortKey = k; renderMaster();
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
  document.getElementById("master-count").textContent = `${items.length} article${items.length === 1 ? "" : "s"}` + (items.length > rows.length ? ` — showing first ${rows.length}` : "");
  document.getElementById("master-more").hidden = items.length <= rows.length;
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
    await moveToTrash(mine);
    await logAudit("bulk deleted", "", `${arts.size} article(s), ${mine.length} version(s)`);
    master.selected.clear();
    invalidateSotCache();
  } catch (err) { alert("Could not delete: " + err.message); }
  btn.disabled = false;
});

["master-search"].forEach((id) => onId(id, "input", () => { master.shown = 100; renderMaster(); }));
["master-customer", "master-brand", "master-category", "master-ops"].forEach((id) => onId(id, "change", () => { master.shown = 100; renderMaster(); }));
onId("master-more", "click", () => { master.shown += 200; renderMaster(); });

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
  };
}

const removedExtra = new Set(); // extra photos the user crossed out while editing
let baseItem = null; // the entry being edited / versioned, so fields the form has no box for are not lost
let editingId = null; // set when the Add form is being used to edit an existing doc, instead of creating one

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
      statusBox.textContent = "Uploading photo…";
      const photoUrl = await uploadToCloudinary(photoFile);
      statusBox.textContent = "Generating embedding…";
      const embedding = await embedImage(photoUrl);
      statusBox.textContent = "Saving…";
      const isNewVersion = await saveSotWithVersioning({ ...formData, photoUrl, embedding });
      logAudit(isNewVersion ? "new version" : "added", formData.article);
      statusBox.textContent = isNewVersion
        ? `Saved as a new version of ${formData.article}. Previous data kept as history.`
        : "Saved.";
    }
    dupNotice.style.display = "none";
    e.target.reset();
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

function exitEditMode() {
  editingId = null; baseItem = null; removedExtra.clear(); renderExtraPhotoList();
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
    await moveToTrash(all.filter((d) => d.id === item.id));
    await fixLatestFlags(all.filter((d) => d.id !== item.id), new Set([item.article]));
    await logAudit("deleted", item.article, item.year ? "version " + item.year : "");
    backdrop.hidden = true;
    invalidateSotCache();
  } catch (err) { alert("Could not delete: " + err.message); }
}
async function deleteSotArticle(item) {
  if (!canManageUsers(currentProfile.role)) return;
  if (!confirm(`Delete article ${item.article} with ALL its versions?\nThey go to the recycle bin for 30 days.`)) return;
  try {
    const all = await getAllSotDocs();
    const mine = all.filter((d) => d.article === item.article);
    await moveToTrash(mine);
    await logAudit("deleted article", item.article, mine.length + " version(s)");
    backdrop.hidden = true;
    invalidateSotCache();
  } catch (err) { alert("Could not delete: " + err.message); }
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
  document.getElementById("modal-summary").textContent = sumLine + (sotSum > 0 ? (sumLine ? "\n" : "") + "SOT " + sotSum.toFixed(1) + " min" : "");

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
// Insights tab: average SOT and operation minutes per customer / brand / category
// ============================================================
async function renderInsights() {
  const all = await getAllLatestSots();
  const by = document.getElementById("ins-group").value;
  const custSel = document.getElementById("ins-customer");
  const custCur = custSel.value;
  const custs = [...new Set(all.map((it) => String(it.costing?.Customer || "").trim()).filter(Boolean))].sort(natCmp);
  custSel.innerHTML = '<option value="">All customers</option>' + custs.map((c) => `<option>${esc(c)}</option>`).join("");
  custSel.value = custs.includes(custCur) ? custCur : "";
  const getter = { customer: (it) => String(it.costing?.Customer || "").trim(), brand: brandOf, category: categoryOf }[by];
  const pool = all.filter((it) => !custSel.value || String(it.costing?.Customer || "").trim() === custSel.value);
  const groups = new Map();
  pool.forEach((it) => { const k = getter(it) || "(not set)"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); });
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const r1 = (v) => Math.round(v * 10) / 10;
  const list = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const withTotal = (items) => items.map((it) => totalMinutes(it.businessSOT)).filter((t) => t > 0);
  const label = { customer: "Customer", brand: "Brand", category: "Category" }[by];
  document.getElementById("ins-summary").innerHTML = `<tr><th>${label}</th><th>Articles</th><th>Average SOT (min)</th><th>Lowest</th><th>Highest</th></tr>` +
    list.map(([k, items]) => { const t = withTotal(items); return `<tr><td>${esc(k)}</td><td>${items.length}</td><td>${t.length ? r1(avg(t)) : ""}</td><td>${t.length ? r1(Math.min(...t)) : ""}</td><td>${t.length ? r1(Math.max(...t)) : ""}</td></tr>`; }).join("");
  const ops = BUSINESS_SOT_OPERATIONS.concat([...new Set(pool.flatMap((it) => Object.keys(it.businessSOT || {})))].filter((o) => !BUSINESS_SOT_OPERATIONS.includes(o)))
    .filter((op) => pool.some((it) => Number(it.businessSOT?.[op]) > 0));
  document.getElementById("ins-ops").innerHTML = `<tr><th>${label}</th>${ops.map((o) => `<th class="op-col">${esc(o)}</th>`).join("")}</tr>` +
    list.map(([k, items]) => `<tr><td>${esc(k)}</td>${ops.map((op) => {
      const v = items.map((it) => Number(it.businessSOT?.[op])).filter((x) => x > 0);
      return `<td class="op-col">${v.length ? r1(avg(v)) : ""}</td>`;
    }).join("")}</tr>`).join("");
  document.getElementById("ins-note").textContent = `${pool.length} article${pool.length === 1 ? "" : "s"}. Operation averages count only articles that use that operation.`;
}
["ins-group", "ins-customer"].forEach((id) => onId(id, "change", () => renderInsights()));

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
      list.push({ col, row, ext, base64: awai
