import {
  auth, db, MASTER_GOD_UID, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET,
} from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, updateProfile,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, getDocs, collection, query, where,
  updateDoc, deleteDoc, onSnapshot, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// The AI model that turns a photo into a vector, running fully in the
// browser — no server involved. First use downloads the model and the
// browser caches it after that.
import { pipeline } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

// ============================================================
// The fixed Business SOT operation list — every SOT card uses
// exactly these rows (blank means "not used" for that article).
// ============================================================
const BUSINESS_SOT_OPERATIONS = [
  "Lamination", "Cutting", "Crimping", "Skiving", "UV-marking", "Embossed/Heat-seal",
  "Seamless", "Printing", "Fusing", "Loop Cutting", "Heat press", "Heat Cut", "Brush",
  "Edge color/Spray", "Bootie", "Pattern Sewing", "Embroidery", "Stitching", "UV Treatment",
  "Buffing", "Stock Fitting", "Socks Preparation", "Footbed Preparation", "Insole Preparation",
  "Sole Stitch/Preparation", "Cemented/DIP", "Packing",
];

let embedder = null;
async function getEmbedder() {
  if (!embedder) embedder = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32");
  return embedder;
}
async function embedImage(fileOrUrl) {
  const model = await getEmbedder();
  const output = await model(fileOrUrl, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are normalized, so dot product == cosine similarity
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

document.getElementById("show-signup").addEventListener("click", () => {
  document.getElementById("form-login").hidden = true;
  document.getElementById("show-signup").hidden = true;
  document.getElementById("form-signup").hidden = false;
});
document.getElementById("show-login").addEventListener("click", () => {
  document.getElementById("form-signup").hidden = true;
  document.getElementById("form-login").hidden = false;
  document.getElementById("show-signup").hidden = false;
});

document.getElementById("form-signup").addEventListener("submit", async (e) => {
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
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorBox = document.getElementById("login-error");
  errorBox.hidden = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }
});
document.getElementById("signout-btn").addEventListener("click", () => signOut(auth));
document.getElementById("pending-signout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) { showScreen("login"); return; }
  const snap = await getDoc(doc(db, "users", user.uid));
  currentProfile = snap.exists() ? snap.data() : null;
  if (!currentProfile || !currentProfile.approved) { showScreen("pending"); return; }
  showScreen("app");
  applyRoleToUI(currentProfile.role);
  document.getElementById("user-name").textContent = currentProfile.name || user.email;
  document.getElementById("user-role").textContent = currentProfile.role.replace("_", " ");
  if (canManageUsers(currentProfile.role)) watchUsers();
});

function applyRoleToUI(role) {
  document.getElementById("nav-upload").hidden = !canUpload(role);
  document.getElementById("nav-import").hidden = !canUpload(role);
  document.getElementById("nav-users").hidden = !canManageUsers(role);
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
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
  return isNewVersion;
}

function renderResults(container, items, showScore) {
  container.innerHTML = "";
  if (items.length === 0) { container.hidden = true; return; }
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <img src="${item.photoUrl || ""}" alt="${item.construction?.Construction || ""}" />
      <div class="result-card-body">
        <span class="result-article">${item.article || "—"}</span>
        <p class="result-name">${item.construction?.Construction || "Untitled"}</p>
        <p class="result-material">${item.construction?.Outsole || ""}</p>
        ${showScore ? `<span class="result-score">${Math.round(item.score * 100)}% match</span>` : ""}
      </div>`;
    card.addEventListener("click", () => openModal(item));
    container.appendChild(card);
  });
  container.hidden = false;
}

// ============================================================
// Image match tab
// ============================================================
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => e.preventDefault());
dropzone.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleMatchFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleMatchFile(fileInput.files[0]); });

async function handleMatchFile(file) {
  const url = URL.createObjectURL(file);
  const preview = document.getElementById("preview-img");
  preview.src = url; preview.hidden = false;
  document.getElementById("dropzone-empty").hidden = true;

  const status = document.getElementById("match-status");
  const results = document.getElementById("match-results");
  results.hidden = true; status.hidden = false; status.textContent = "Loading model + generating embedding…";

  try {
    const queryVector = await embedImage(url);
    status.textContent = "Comparing against saved constructions…";
    const snap = await getDocs(query(collection(db, "sots"), where("isLatest", "==", true)));
    const scored = [];
    snap.forEach((d) => {
      const data = d.data();
      if (!data.embedding) return;
      scored.push({ ...data, id: d.id, score: cosineSimilarity(queryVector, data.embedding) });
    });
    scored.sort((a, b) => b.score - a.score);
    status.hidden = true;
    renderResults(results, scored.slice(0, 6), true);
    if (scored.length === 0) {
      status.hidden = false;
      status.textContent = "No SOT entries in the database yet — add or import some first.";
    }
  } catch (err) {
    status.textContent = "Something went wrong: " + err.message;
  }
}

// ============================================================
// Article search tab (latest version only; history is inside the modal)
// ============================================================
document.getElementById("article-search-btn").addEventListener("click", runArticleSearch);
document.getElementById("article-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runArticleSearch(); });

async function runArticleSearch() {
  const value = document.getElementById("article-input").value.trim();
  const resultsBox = document.getElementById("search-results");
  const emptyBox = document.getElementById("search-empty");
  if (!value) return;
  const q = query(collection(db, "sots"), where("article", "==", value), where("isLatest", "==", true));
  const snap = await getDocs(q);
  const items = [];
  snap.forEach((d) => items.push({ ...d.data(), id: d.id }));
  if (items.length === 0) { resultsBox.hidden = true; emptyBox.hidden = false; }
  else { emptyBox.hidden = true; renderResults(resultsBox, items, false); }
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
    <td><input type="number" step="0.1" class="sot-min" value="${min}" style="width:90px;" /></td>
    <td>${locked ? "" : `<button type="button" class="btn-small btn-danger row-remove">✕</button>`}</td>`;
  if (!locked) tr.querySelector(".row-remove").addEventListener("click", () => { tr.remove(); updateSotTotal(); });
  tr.querySelectorAll("input.sot-min").forEach((inp) => inp.addEventListener("input", updateSotTotal));
  sotTable.appendChild(tr);
}
function updateSotTotal() {
  let total = 0;
  sotTable.querySelectorAll(".sot-min").forEach((inp) => (total += Number(inp.value || 0)));
  document.getElementById("add-sot-total").textContent = total.toFixed(1);
}
document.getElementById("add-sot-row").addEventListener("click", () => addSotRow());
BUSINESS_SOT_OPERATIONS.forEach((op) => addSotRow(op, "", true));

function resetSotTable() {
  sotTable.querySelectorAll("tr").forEach((tr, i) => { if (i > 0) tr.remove(); });
  BUSINESS_SOT_OPERATIONS.forEach((op) => addSotRow(op, "", true));
}

const dupNotice = document.getElementById("duplicate-notice");
document.getElementById("add-article").addEventListener("blur", async (e) => {
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
    construction: {
      Construction: document.getElementById("add-construction").value.trim(),
      Outsole: document.getElementById("add-outsole").value.trim(),
      "Upper Material": document.getElementById("add-upper").value.trim(),
      "Cemented/DIP": document.getElementById("add-cemented").value.trim(),
      "Safety Toe": document.getElementById("add-safety").value,
      "WP/NWP": document.getElementById("add-wp").value,
    },
    costing: {
      Customer: document.getElementById("add-customer").value.trim(),
      Stage: document.getElementById("add-stage").value.trim(),
      "Size Range": document.getElementById("add-size").value.trim(),
      Gender: document.getElementById("add-gender").value,
      "Order Qty": document.getElementById("add-qty").value.trim(),
      "Order Status": document.getElementById("add-status-field").value.trim(),
      "Received Date": document.getElementById("add-received").value,
      "Delivery Date": document.getElementById("add-delivery").value,
    },
    businessSOT,
    efficiency: {
      "Assembly OWE": document.getElementById("add-assembly-owe").value.trim(),
      "Assembly Manpower (D)": document.getElementById("add-assembly-manpower").value,
      "Target Output/HR Avg (Assembly)": document.getElementById("add-target-assembly").value,
      "Highest Possible Output/HR": document.getElementById("add-highest-output").value,
      "Stitching OWE": document.getElementById("add-stitching-owe").value.trim(),
      "Stitching Manpower (D)": document.getElementById("add-stitching-manpower").value,
      "Target Output/HR Avg (Sewing)": document.getElementById("add-target-sewing").value,
    },
    notes: {
      "Special Note": document.getElementById("add-special-note").value.trim(),
      "Tech. Data": document.getElementById("add-tech-data").value.trim(),
      "Physical Sample": document.getElementById("add-physical-sample").value.trim(),
      "Sample Autopsy": document.getElementById("add-sample-autopsy").value.trim(),
      Recommendation: document.getElementById("add-recommendation").value,
    },
  };
}

document.getElementById("form-add-sot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusBox = document.getElementById("add-status");
  statusBox.hidden = false; statusBox.textContent = "Uploading photo…";
  const photoFile = document.getElementById("add-photo").files[0];

  try {
    const photoUrl = await uploadToCloudinary(photoFile);
    statusBox.textContent = "Generating embedding…";
    const embedding = await embedImage(photoUrl);
    statusBox.textContent = "Saving…";

    const formData = collectAddForm();
    const isNewVersion = await saveSotWithVersioning({ ...formData, photoUrl, embedding });

    statusBox.textContent = isNewVersion
      ? `Saved as a new version of ${formData.article}. Previous data kept as history.`
      : "Saved.";
    dupNotice.style.display = "none";
    e.target.reset();
    resetSotTable();
  } catch (err) {
    statusBox.textContent = "Failed: " + err.message;
  }
});

// ============================================================
// Detail modal — construction, costing, Business SOT, efficiency,
// notes, and other versions of the same article
// ============================================================
const backdrop = document.getElementById("modal-backdrop");
document.getElementById("modal-close").addEventListener("click", () => (backdrop.hidden = true));
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
  document.getElementById("modal-article").textContent = item.article;
  document.getElementById("modal-name").textContent = item.construction?.Construction || "Untitled";
  const vTag = document.getElementById("modal-version");
  vTag.style.display = "none";

  kvGrid(document.getElementById("modal-construction"), item.construction);
  kvGrid(document.getElementById("modal-costing"), item.costing);

  const effBlock = document.getElementById("modal-efficiency-block");
  const hasEff = item.efficiency && Object.values(item.efficiency).some((v) => v);
  effBlock.style.display = hasEff ? "block" : "none";
  if (hasEff) kvGrid(document.getElementById("modal-efficiency"), item.efficiency);

  const notesBlock = document.getElementById("modal-notes-block");
  const hasNotes = item.notes && Object.values(item.notes).some((v) => v);
  notesBlock.style.display = hasNotes ? "block" : "none";
  if (hasNotes) kvGrid(document.getElementById("modal-notes"), item.notes);

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
// KNOWN_LABELS maps a row label (as it appears in column A of an
// article-card sheet) to where it lands in our schema.
const KNOWN_LABELS = [
  { label: "customer", target: "costing", key: "Customer" },
  { label: "ordered yet", target: "costing", key: "Ordered Yet" },
  { label: "stage", target: "costing", key: "Stage" },
  { label: "types of shoe", target: "costing", key: "Types of Shoe" },
  { label: "received date", target: "costing", key: "Received Date" },
  { label: "delivery date", target: "costing", key: "Delivery Date" },
  { label: "size range", target: "costing", key: "Size Range" },
  { label: "gender", target: "costing", key: "Gender" },
  { label: "initial order qty", target: "costing", key: "Order Qty" },
  { label: "order status", target: "costing", key: "Order Status" },
  { label: "upper material", target: "construction", key: "Upper Material" },
  { label: "safety toe", target: "construction", key: "Safety Toe" },
  { label: "wp/nwp", target: "construction", key: "WP/NWP" },
  { label: "cemented/dip", target: "construction", key: "Cemented/DIP" },
  { label: "construction", target: "construction", key: "Construction" },
  { label: "outsole", target: "construction", key: "Outsole" },
];

let importQueue = []; // [{article, construction, costing, imageDataUrl}]

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusBox = document.getElementById("import-status");
  statusBox.hidden = false; statusBox.textContent = "Reading workbook…";

  try {
    const [{ default: JSZip }, XLSX] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm"),
      import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"),
    ]);
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: "array" });
    const zip = await JSZip.loadAsync(buf);

    // Pull every embedded image out of the workbook, in filename
    // order (image1, image2, ...). NOTE: this assumes images were
    // inserted in the same left-to-right, sheet-by-sheet order as
    // the article blocks below — true for the standard costing-sheet
    // layout, but double-check the preview thumbnails before confirming.
    const mediaFiles = Object.keys(zip.files)
      .filter((p) => /^xl\/media\/image\d+\./.test(p))
      .sort((a, b) => {
        const na = Number(a.match(/image(\d+)/)[1]);
        const nb = Number(b.match(/image(\d+)/)[1]);
        return na - nb;
      });
    const images = [];
    for (const path of mediaFiles) {
      const blob = await zip.files[path].async("base64");
      const ext = path.split(".").pop();
      images.push(`data:image/${ext === "jpg" ? "jpeg" : ext};base64,${blob}`);
    }

    importQueue = [];
    let imgIndex = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (!rows[0] || String(rows[0][0]).trim().toLowerCase() !== "article name") continue; // skip non-article-card sheets

      // Build label -> row index map from column A
      const labelRow = {};
      rows.forEach((r, i) => {
        const label = String(r[0] || "").trim().toLowerCase();
        if (label) labelRow[label] = i;
      });

      // Block-start columns = non-empty cells in the header row, after column 0
      const headerRow = rows[0];
      for (let col = 1; col < headerRow.length; col++) {
        const article = String(headerRow[col] || "").trim();
        if (!article) continue;

        const construction = {};
        const costing = {};
        KNOWN_LABELS.forEach(({ label, target, key }) => {
          const rIdx = labelRow[label];
          if (rIdx === undefined) return;
          const val = rows[rIdx] ? rows[rIdx][col] : "";
          if (val !== "" && val !== undefined) (target === "costing" ? costing : construction)[key] = val;
        });
        construction.Construction = construction.Construction || "";

        importQueue.push({
          article,
          construction,
          costing,
          imageDataUrl: images[imgIndex] || null,
        });
        imgIndex++;
      }
    }

    statusBox.textContent = `Found ${importQueue.length} article${importQueue.length === 1 ? "" : "s"}. Review below, then confirm.`;
    renderImportPreview();
    document.getElementById("import-confirm-btn").style.display = importQueue.length ? "inline-block" : "none";
  } catch (err) {
    statusBox.textContent = "Couldn't read that file: " + err.message;
  }
});

function renderImportPreview() {
  const box = document.getElementById("import-preview");
  box.innerHTML = "";
  importQueue.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "import-row";
    div.innerHTML = `
      <img src="${row.imageDataUrl || ""}" />
      <div><strong>${row.article}</strong><div class="muted" style="font-size:12px;">${row.construction.Construction || "—"} · ${row.construction.Outsole || "—"}</div></div>
      <span class="status" id="import-status-${i}">ready</span>`;
    box.appendChild(div);
  });
}

document.getElementById("import-confirm-btn").addEventListener("click", async () => {
  const btn = document.getElementById("import-confirm-btn");
  btn.disabled = true;
  for (let i = 0; i < importQueue.length; i++) {
    const row = importQueue[i];
    const statusEl = document.getElementById(`import-status-${i}`);
    try {
      statusEl.textContent = "uploading photo…";
      const photoUrl = row.imageDataUrl ? await uploadToCloudinary(dataUrlToFile(row.imageDataUrl, `${row.article}.jpg`)) : "";
      statusEl.textContent = "embedding…";
      const embedding = photoUrl ? await embedImage(photoUrl) : new Array(512).fill(0);
      statusEl.textContent = "saving…";
      const isNewVersion = await saveSotWithVersioning({
        article: row.article,
        construction: row.construction,
        costing: row.costing,
        businessSOT: {},
        efficiency: {},
        notes: {},
        photoUrl,
        embedding,
      });
      statusEl.textContent = isNewVersion ? "saved (new version)" : "saved";
    } catch (err) {
      statusEl.textContent = "failed: " + err.message;
    }
  }
  btn.disabled = false;
  document.getElementById("import-status").textContent = "Import finished — check the statuses above.";
});

function dataUrlToFile(dataUrl, filename) {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*);base64/)[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}
