// ============================================================
// FIREBASE CONFIG — fill this in with YOUR project's values.
// Get these from: Firebase console → Project settings → General
// → "Your apps" → Web app → SDK setup and configuration.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Import the functions you need from the SDKs you need

import { initializeApp } from "firebase/app";

import { getAnalytics } from "firebase/analytics";

// TODO: Add SDKs for Firebase products that you want to use

// https://firebase.google.com/docs/web/setup#available-libraries


// Your web app's Firebase configuration

// For Firebase JS SDK v7.20.0 and later, measurementId is optional


const firebaseConfig = {
  apiKey: "AIzaSyDElHAfFkcAi26I8Z6PxLPf7VMU33fc6mk",

  authDomain: "edison-sot.firebaseapp.com",

  projectId: "edison-sot",

  storageBucket: "edison-sot.firebasestorage.app",

  messagingSenderId: "33778528183",

  appId: "1:33778528183:web:ebc6bd8d110d73feec8232",

  measurementId: "G-CQLLW3PK1E",
};

// ============================================================
// CLOUDINARY CONFIG — from cloudinary.com dashboard.
// The upload preset must be "unsigned" (Settings → Upload →
// Upload presets → Add preset → Signing mode: Unsigned).
// ============================================================
export const CLOUDINARY_CLOUD_NAME = "YOUR_CLOUD_NAME";
export const CLOUDINARY_UPLOAD_PRESET = "YOUR_UNSIGNED_PRESET";

// ============================================================
// MASTER GOD — the one account nobody (including Masters) can
// demote or delete. Put the real UID here after that account
// signs up once (Firebase console → Authentication → find the
// user → copy their User UID).
// ============================================================
export const MASTER_GOD_UID = "PUT_YOUR_MASTER_GOD_UID_HERE";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
