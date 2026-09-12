# SOT Match — সেটআপ গাইড

এই অ্যাপ Firebase (login + database) আর Cloudinary (ছবি) দিয়ে চলে, দুটোই ফ্রি। নিজের account-এর সাথে যুক্ত করতে একবার নিচের ধাপগুলো করো।

## ১. Firebase project বানাও

যাও https://console.firebase.google.com → **Add project** → একটা নাম দাও (যেমন `edison-sot-match`) → wizard শেষ করো।

## ২. Authentication চালু করো

বাম sidebar-এ: **Build → Authentication → Get started** → **Email/Password** enable করো।

## ৩. Database বানাও

**Build → Firestore Database → Create database** → **Production mode** বেছে নাও, কাছাকাছি একটা location দাও।

## ৪. Web app config নাও

1. Gear আইকন → **Project settings**
2. নিচে "Your apps" → **`</>`** (web) আইকন → যেকোনো নাম দিয়ে register করো
3. দেখানো `firebaseConfig` অবজেক্টটা কপি করো
4. এই প্রজেক্টের `firebase-config.js` খুলে placeholder-এর জায়গায় বসাও:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "...",
  appId: "...",
};
```

## ৫. Cloudinary সেট করো (ছবির জন্য, ফ্রি, কার্ড লাগে না)

1. যাও https://cloudinary.com/users/register/free → ফ্রি account বানাও
2. Dashboard-এর উপরে **"Cloud name"** কপি করো
3. **Settings** (gear) → **Upload** → নিচে **"Upload presets"** → **"Add upload preset"**
   - **"Signing Mode"** → **UNSIGNED** করো (এটা ছাড়া আপলোড কাজ করবে না)
   - যেকোনো নাম দাও → Save
4. এই প্রজেক্টের `cloudinary-config.js` খুলে বসাও:

```js
export const cloudName = "your-cloud-name";
export const uploadPreset = "your-preset-name";
```

## ৬. Firestore security rules বসাও

Firestore → **Rules** → ডিফল্ট rules মুছে এই প্রজেক্টের `firestore.rules` ফাইলের পুরো কনটেন্ট paste করো → **Publish**।

*(এই ধাপ ছাড়া role/permission কিছুই কাজ করবে না।)*

## ৭. চালাও

ব্রাউজার সরাসরি `file://` থেকে module import ব্লক করে, তাই local server লাগবে:

- VS Code: "Live Server" extension → `index.html`-এ right-click → **Open with Live Server**
- অথবা টার্মিনালে এই ফোল্ডারে গিয়ে: `python3 -m http.server 8000` → ব্রাউজারে `http://localhost:8000`

## ৮. প্রথম সাইন-আপ = Master God

যে প্রথম "Request access" দিয়ে account বানাবে, তাকে ম্যানুয়ালি একবার Master God বানাতে হবে (এরপর automatic):

1. অ্যাপে একবার সাইন আপ করো
2. Firebase Console → Authentication → Users → নিজের account-এর **User UID** কপি করো
3. `firebase-config.js`-এ `MASTER_GOD_UID` আর `firestore.rules`-এ `MASTER_GOD_UID_HERE` — দুই জায়গাতেই এই UID বসাও, rules আবার Publish করো
4. Firestore → Data → `users` collection → নিজের document → `role: master_god`, `approved: true` ম্যানুয়ালি বসাও

এরপর থেকে নতুন যে কেউ সাইন আপ করবে, Master/Master God-এর **Users** ট্যাব থেকে approve না করা পর্যন্ত ঢুকতে পারবে না।

## GitHub Pages-এ Deploy করা

`index.html`, `style.css`, `app.js`, `firebase-config.js`, `cloudinary-config.js`, `firestore.rules` — এই ফাইলগুলো একটা repo-তে push করো, তারপর **Settings → Pages → `main` branch** থেকে deploy করো — একটা পাবলিক লিংক পেয়ে যাবে, আলাদা কোনো server লাগবে না।

## Excel import নিয়ে একটা কথা

ছবি আর article মেলানো হয় ফাইলের ভেতরের ক্রম ধরে (assume করা হয় ছবিগুলো article-এর একই বাম-থেকে-ডান ক্রমে সেভ আছে)। Import করার পর **Confirm করার আগে প্রতিটা ছবি চোখে মিলিয়ে দেখো**।

## এখনো যা বাকি

- Existing entry এডিট করার UI (এখন শুধু নতুন version হিসেবে re-add করা যায়)
- অনেক বড় ডেটাসেটে (হাজার হাজার entry) Firestore-এর native vector index — এখন সব entry browser-এ এনে compare করা হয়
