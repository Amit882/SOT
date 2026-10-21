import { auth, db, MASTER_GOD_UID } from "./firebase-config.js";
import { cloudName as CLOUDINARY_CLOUD_NAME, uploadPreset as CLOUDINARY_UPLOAD_PRESET } from "./cloudinary-config.js";
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
    if (btn.dataset.tab === "tab-upload" && editingId) {
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

let editingId = null; // set when the Add form is being used to edit an existing doc, instead of creating one

document.getElementById("form-add-sot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusBox = document.getElementById("add-status");
  statusBox.hidden = false;
  const photoFile = document.getElementById("add-photo").files[0];

  try {
    const formData = collectAddForm();

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
      statusBox.textContent = "Entry updated.";
      exitEditMode();
    } else {
      statusBox.textContent = "Uploading photo…";
      const photoUrl = await uploadToCloudinary(photoFile);
      statusBox.textContent = "Generating embedding…";
      const embedding = await embedImage(photoUrl);
      statusBox.textContent = "Saving…";
      const isNewVersion = await saveSotWithVersioning({ ...formData, photoUrl, embedding });
      statusBox.textContent = isNewVersion
        ? `Saved as a new version of ${formData.article}. Previous data kept as history.`
        : "Saved.";
    }
    dupNotice.style.display = "none";
    e.target.reset();
    resetSotTable();
  } catch (err) {
    statusBox.textContent = "Failed: " + err.message;
  }
});

// Fills the Add-SOT form with an existing entry's data and switches
// the form into "edit this exact document" mode (no versioning).
function enterEditMode(item) {
  editingId = item.id;
  document.getElementById("add-article").value = item.article || "";
  document.getElementById("add-photo").required = false; // keep existing photo unless a new one is chosen
  document.getElementById("add-construction").value = item.construction?.Construction || "";
  document.getElementById("add-outsole").value = item.construction?.Outsole || "";
  document.getElementById("add-upper").value = item.construction?.["Upper Material"] || "";
  document.getElementById("add-cemented").value = item.construction?.["Cemented/DIP"] || "";
  document.getElementById("add-safety").value = item.construction?.["Safety Toe"] || "No";
  document.getElementById("add-wp").value = item.construction?.["WP/NWP"] || "No";
  document.getElementById("add-customer").value = item.costing?.Customer || "";
  document.getElementById("add-stage").value = item.costing?.Stage || "";
  document.getElementById("add-size").value = item.costing?.["Size Range"] || "";
  document.getElementById("add-gender").value = item.costing?.Gender || "Men";
  document.getElementById("add-qty").value = item.costing?.["Order Qty"] || "";
  document.getElementById("add-status-field").value = item.costing?.["Order Status"] || "";
  document.getElementById("add-received").value = item.costing?.["Received Date"] || "";
  document.getElementById("add-delivery").value = item.costing?.["Delivery Date"] || "";
  document.getElementById("add-assembly-owe").value = item.efficiency?.["Assembly OWE"] || "";
  document.getElementById("add-assembly-manpower").value = item.efficiency?.["Assembly Manpower (D)"] || "";
  document.getElementById("add-target-assembly").value = item.efficiency?.["Target Output/HR Avg (Assembly)"] || "";
  document.getElementById("add-highest-output").value = item.efficiency?.["Highest Possible Output/HR"] || "";
  document.getElementById("add-stitching-owe").value = item.efficiency?.["Stitching OWE"] || "";
  document.getElementById("add-stitching-manpower").value = item.efficiency?.["Stitching Manpower (D)"] || "";
  document.getElementById("add-target-sewing").value = item.efficiency?.["Target Output/HR Avg (Sewing)"] || "";
  document.getElementById("add-special-note").value = item.notes?.["Special Note"] || "";
  document.getElementById("add-tech-data").value = item.notes?.["Tech. Data"] || "";
  document.getElementById("add-physical-sample").value = item.notes?.["Physical Sample"] || "";
  document.getElementById("add-sample-autopsy").value = item.notes?.["Sample Autopsy"] || "";
  document.getElementById("add-recommendation").value = item.notes?.Recommendation || "";

  resetSotTable();
  Object.entries(item.businessSOT || {}).forEach(([op, min]) => {
    const lockedRow = Array.from(sotTable.querySelectorAll("tr")).find((tr) => tr.querySelector(".sot-op")?.value === op);
    if (lockedRow) lockedRow.querySelector(".sot-min").value = min;
    else addSotRow(op, min);
  });
  updateSotTotal();

  document.getElementById("form-add-sot").querySelector('button[type="submit"]').textContent = "Update entry";
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('[data-tab="tab-upload"]').classList.add("active");
  document.getElementById("tab-upload").classList.add("active");
  backdrop.hidden = true;
}

function exitEditMode() {
  editingId = null;
  document.getElementById("add-photo").required = true;
  document.getElementById("form-add-sot").querySelector('button[type="submit"]').textContent = "Save entry";
}

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

  const editBtn = document.getElementById("modal-edit-btn");
  editBtn.style.display = canUpload(currentProfile.role) ? "inline-block" : "none";
  editBtn.onclick = () => enterEditMode(item);

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

const TOP_LABELS = {
  "customer": ["costing", "Customer"],
  "ordered yet": ["costing", "Ordered Yet"],
  "stage": ["costing", "Stage"],
  "types of shoe": ["costing", "Types of Shoe"],
  "version": ["costing", "Version"],
  "received date": ["costing", "Received Date"],
  "delivery date": ["costing", "Delivery Date"],
  "size range": ["costing", "Size Range"],
  "gender": ["costing", "Gender"],
  "initial order qty": ["costing", "Order Qty"],
  "order status": ["costing", "Order Status"],
  "upper material": ["construction", "Upper Material"],
  "safety toe": ["construction", "Safety Toe"],
  "wp/nwp": ["construction", "WP/NWP"],
  "cemented/dip": ["construction", "Cemented/DIP"],
  "construction": ["construction", "Construction"],
  "outsole": ["construction", "Outsole"],
};
const DATE_KEYS = new Set(["Received Date", "Delivery Date"]);
const OP_BY_NORM = Object.fromEntries(BUSINESS_SOT_OPERATIONS.map((op) => [normLabel(op), op]));

// Efficiency rows are matched by what the label starts with.
function efficiencyKey(label) {
  if (label.startsWith("assembly owe")) return "Assembly OWE";
  if (label.startsWith("assembly manpower")) return "Assembly Manpower (D)";
  if (label.startsWith("target output/hr") && label.includes("assemb")) return "Target Output/HR Avg (Assembly)";
  if (label.startsWith("highest possible")) return "Highest Possible Output/HR";
  if (label.startsWith("stitching owe")) return "Stitching OWE";
  if (label.startsWith("stitching manpower")) return "Stitching Manpower (D)";
  if (label.startsWith("target output/hr") && label.includes("sewing")) return "Target Output/HR Avg (Sewing)";
  return null;
}
const NOTE_KEYS = {
  "special note:": "Special Note", "special note": "Special Note",
  "tech. data": "Tech. Data", "tech data": "Tech. Data",
  "physical sample": "Physical Sample",
  "sample autopsy": "Sample Autopsy",
  "recommendation": "Recommendation",
};

function cleanCell(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number") return Math.round(v * 100) / 100;
  return String(v).trim();
}

// Reads one sheet's rows into [{article, construction, costing, businessSOT, efficiency, notes, col}]
function parseArticleSheet(XLSX, sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  if (!rows[0] || normLabel(rows[0][0]) !== "article name") return [];

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
    const get = (r) => (rows[r] ? rows[r][col] : "");

    const construction = {}, costing = {}, businessSOT = {}, efficiency = {}, notes = {};

    // top section: first occurrence of each label wins
    const seen = new Set();
    for (let r = 1; r < timeRow; r++) {
      const label = normLabel(rows[r][0]);
      const t = TOP_LABELS[label];
      if (!t || seen.has(label)) continue;
      seen.add(label);
      let v = get(r);
      if (v === "" || v === undefined) continue;
      if (DATE_KEYS.has(t[1]) && typeof v === "number") {
        const d = XLSX.SSF.parse_date_code(v);
        v = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
      }
      (t[0] === "costing" ? costing : construction)[t[1]] = cleanCell(v);
    }
    construction.Construction = construction.Construction || "";

    // Business SOT minutes (first column of the block only)
    for (let r = timeRow + 1; r < totalRow; r++) {
      const op = OP_BY_NORM[normLabel(rows[r][0])];
      const v = get(r);
      if (op && typeof v === "number") businessSOT[op] = Math.round(v * 100) / 100;
    }

    // efficiency + notes (below the Total row)
    for (let r = totalRow + 1; r < rows.length; r++) {
      const label = normLabel(rows[r][0]);
      if (!label) continue;
      const effKey = efficiencyKey(label);
      if (effKey) { const v = cleanCell(get(r)); if (v !== "") efficiency[effKey] = v; continue; }
      const noteKey = NOTE_KEYS[label];
      if (noteKey) {
        let v = cleanCell(get(r));
        // "Special Note:" has its text on the row underneath the label
        if (v === "" && noteKey === "Special Note") v = cleanCell(get(r + 1));
        if (v !== "") notes[noteKey] = v;
      }
    }

    out.push({ article, construction, costing, businessSOT, efficiency, notes, col });
  }
  return out;
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
// ---- PARSER END ----

let importQueue = []; // [{article, construction, costing, businessSOT, efficiency, notes, imageDataUrl}]

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

    // Photos are optional: if the zip can't be read for images, still import the data.
    let imagesBySheet = {};
    try {
      const zip = await JSZip.loadAsync(buf);
      imagesBySheet = await extractSheetImages(zip);
    } catch (imgErr) {
      console.warn("Could not read photos from workbook:", imgErr);
    }

    importQueue = [];
    for (const sheetName of workbook.SheetNames) {
      const articles = parseArticleSheet(XLSX, workbook.Sheets[sheetName]);
      for (const a of articles) {
        importQueue.push({ ...a, imageDataUrl: pickImageForArticle(imagesBySheet[sheetName], a.col) });
      }
    }

    const withPhoto = importQueue.filter((r) => r.imageDataUrl).length;
    statusBox.textContent = `Found ${importQueue.length} article${importQueue.length === 1 ? "" : "s"} (${withPhoto} with photo). Review below, then confirm.`;
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
      ${row.imageDataUrl ? `<img src="${row.imageDataUrl}" />` : `<div class="muted" style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;font-size:10px;border:1px dashed #cdbfa8;border-radius:6px;">no photo</div>`}
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
        businessSOT: row.businessSOT || {},
        efficiency: row.efficiency || {},
        notes: row.notes || {},
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
