
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyDElHAfFkcAi26I8Z6PxLPf7VMU33fc6mk",
  authDomain: "edison-sot.firebaseapp.com",
  projectId: "edison-sot",
  storageBucket: "edison-sot.firebasestorage.app",
  messagingSenderId: "33778528183",
  appId: "1:33778528183:web:ebc6bd8d110d73feec8232"
};

// Replace this placeholder with your actual Firebase user UID
export const MASTER_GOD_UID = "4O2sYhg8efNq9YkNsdDsAy6oDA03";

// Initialize Firebase only once
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
