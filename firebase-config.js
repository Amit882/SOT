// FIREBASE CONFIG — fill this in with YOUR project's values.
// Get these from: Firebase console → Project settings → General
// → "Your apps" → Web app → SDK setup and configuration.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// MASTER GOD — the one account nobody (including Masters) can
// demote or delete. Put the real UID here after that account
// signs up once (Firebase console → Authentication → find the
// user → copy their User UID).
export const MASTER_GOD_UID = "PUT_YOUR_MASTER_GOD_UID_HERE";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
