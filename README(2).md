# SOT Match — Prototype v2

আগের prototype-এর updated ভার্সন। সব discuss করা feature এখানে আছে:

## যা কাজ করে
- Signup + login, "pending" approval flow
- Role-based UI (Viewer / Editor / Master / Master God), Master God protected
- **পুরো SOT card**: Construction reference, Costing/order data, Business SOT (fixed ২৭ operation), Efficiency metrics, Notes
- **Image match** — browser-এ CLIP মডেল দিয়ে embedding বানিয়ে সব SOT-এর সাথে compare
- **Article number search**
- **Versioned history** — একই article number আবার add করলে notify করে, পুরনোটা history-তে রেখে নতুন version হিসেবে সেভ করে (article-এর detail খুললে "Other versions" এ পুরনো সব দেখা যায়)
- **Excel bulk import** — আপনার costing sheet-এর মতো ফরম্যাটের .xlsx আপলোড করলে প্রতিটা article auto-detect করে, ছবি + data বের করে preview দেখায়, তারপর "Confirm import" এ পুরো ডাটাবেসে সেভ হয়

## ⚠️ Excel import নিয়ে গুরুত্বপূর্ণ সীমাবদ্ধতা
ছবি আর article-কে মেলানো হচ্ছে **positional order** ধরে নিয়ে (ফাইলের ভেতরে ছবিগুলো যে ক্রমে সংরক্ষিত আছে, সেটাই article block-এর বাম-থেকে-ডান ক্রমের সাথে মিলবে ধরে নেওয়া হয়েছে) — আপনার sample ফাইলে এই pattern-টাই দেখা গেছে, কিন্তু এটা guarantee করা কঠিন সব ফাইলে। তাই **import করার পর preview-তে প্রতিটা article-এর পাশে যে ছবি বসেছে সেটা ভালো করে চোখে দেখে নিশ্চিত হবেন**, তারপরই "Confirm import" চাপবেন। ভুল হলে সেই entry পরে manually Edit করে ছবি বদলে দেওয়া যাবে (Edit UI এখনও যোগ করা হয়নি — আগে জানাবেন করে দেব)।

## যা এখনও বাকি
- Existing entry এডিট করার UI (এখন শুধু নতুন version হিসেবে re-add করা যায়)
- বড় ডেটাসেটে (হাজার হাজার entry) Firestore-এর native vector index — এখন সব entry browser-এ এনে compare করছে

## সেটআপ — একদম শুরু থেকে, ধাপে ধাপে

প্রতিটা ধাপ শেষ করেই পরেরটায় যাবেন, কোনোটা বাদ দেবেন না — বিশেষ করে ধাপ ৫ (Master God) আর ধাপ ৬ (Rules) বাদ দিলে role/login কিছুই কাজ করবে না।

### ধাপ ১ — Firebase account ও project বানানো
https://console.firebase.google.com এ যান (Google account দিয়ে login থাকতে হবে, যেকোনো Gmail চলবে)। **"Add project"** বাটনে ক্লিক করুন। প্রজেক্টের একটা নাম দিন (যেমন `edison-sot-match`), Next এ ক্লিক করতে থাকুন, Google Analytics এর অপশন আসলে "disable" করে দিতে পারেন (লাগবে না), তারপর **"Create project"** এ ক্লিক করুন। কিছু সময় wait করুন, প্রজেক্ট তৈরি হয়ে যাবে।

### ধাপ ২ — Email/Password login চালু করা
প্রজেক্টের বাম পাশে মেনু থেকে **"Build"** এ ক্লিক করুন, তার নিচে **"Authentication"** এ যান। "Get started" বাটন দেখবেন, ওখানে ক্লিক করুন। একটা লিস্ট আসবে (Google, Email/Password, Phone ইত্যাদি) — **"Email/Password"** এ ক্লিক করে "Enable" toggle অন করুন, Save করুন।

### ধাপ ৩ — Firestore Database চালু করা
আবার বাম পাশে "Build" এর নিচে **"Firestore Database"** এ যান। "Create database" এ ক্লিক করুন। Location হিসেবে আপনার কাছাকাছি কোনো region select করুন (যেমন asia-south1 বা singapore)। **"Start in production mode"** সিলেক্ট করে Next/Enable এ ক্লিক করুন।

### ধাপ ৪ — Web app যোগ করে config বের করা
Project settings এ যেতে হবে — উপরে বাম দিকে gear/⚙️ আইকনে ক্লিক করে "Project settings" এ যান। নিচে scroll করলে "Your apps" সেকশন পাবেন, সেখানে **`</>`** (web) আইকনে ক্লিক করুন। একটা nickname দিন (যেমন `sot-match-web`), "Register app" এ ক্লিক করুন। এখন একটা code block দেখাবে যাতে `firebaseConfig = {...}` লেখা — এটা পুরো কপি করুন। এই প্রজেক্টের `firebase-config.js` ফাইল খুলুন, ওখানে আগে থেকেই একটা `firebaseConfig` object আছে `'YOUR_API_KEY'`-এর মতো placeholder সহ — ওগুলো আপনার real value দিয়ে replace করুন।

### ধাপ ৫ — নিজেকে Master God বানানো
এখন ওয়েবসাইটটা locally চালু করতে হবে (ধাপ ৮ দেখুন কিভাবে), তারপর "Request access" দিয়ে নিজের email/password দিয়ে একবার সাইন আপ করুন। তারপর Firebase console-এ ফিরে গিয়ে Authentication → Users ট্যাবে যান, নিজের account খুঁজে বের করুন, ওখানে একটা লম্বা কোড থাকবে **"User UID"** — এটা কপি করুন। এবার `firebase-config.js` ফাইলে `MASTER_GOD_UID`-এর জায়গায় এটা বসান। `firestore.rules` ফাইলেও `MASTER_GOD_UID_HERE`-এর জায়গায় একই UID বসান। সবশেষে Firestore Database → Data ট্যাবে গিয়ে `users` কালেকশনে নিজের document খুঁজে, `role` ফিল্ডকে `master_god` এবং `approved` ফিল্ডকে `true` করে দিন ম্যানুয়ালি (একবারই করতে হবে — পরের বার থেকে normal signup+approve সিস্টেমে চলবে)।

### ধাপ ৬ — Firestore Security Rules বসানো
Firestore Database এ গিয়ে "Rules" ট্যাবে ক্লিক করুন। আগে থেকে কিছু default code থাকবে, সেটা সব select করে delete করে দিন। এই প্রজেক্টের `firestore.rules` ফাইল থেকে পুরো content কপি করে এখানে paste করুন (যেখানে আপনি `MASTER_GOD_UID_HERE` আগের ধাপে already replace করেছেন)। উপরে **"Publish"** বাটনে ক্লিক করুন। *(এটা না করলে role/permission কাজ করবে না।)*

### ধাপ ৭ — Cloudinary account বানানো
https://cloudinary.com এ গিয়ে ফ্রি account বানান (email দিয়ে সাইন আপ)। Login করার পর Dashboard-এ আগে থেকেই একটা **"Cloud name"** দেখাবে (উপরে) — এটা কপি করে `firebase-config.js`-এ `CLOUDINARY_CLOUD_NAME`-এ বসান। তারপর Settings (gear icon) → Upload ট্যাবে যান, "Upload presets" সেকশনে "Add upload preset"-এ ক্লিক করুন। **"Signing Mode"**-কে **"Unsigned"**-এ change করুন, Save করুন। যে নাম দিলো (যেমন `ml_default` বা নতুন কোনো নাম) সেটা কপি করে `CLOUDINARY_UPLOAD_PRESET`-এ বসান। *(Signing mode Unsigned না করলে ছবি upload fail করবে।)*

### ধাপ ৮ — লোকালি টেস্ট ও GitHub Pages এ পাবলিশ
কম্পিউটারে সব ফাইল (index.html, style.css, app.js, firebase-config.js, firestore.rules) একটা ফোল্ডারে রাখুন। Terminal/Command Prompt খুলে সেই ফোল্ডারে গিয়ে লিখুন:
```
python3 -m http.server 8000
```
তারপর ব্রাউজারে `http://localhost:8000` খুলে টেস্ট করুন। *(ফাইল সরাসরি `file://` দিয়ে খুললে কাজ করবে না, local server চালানো must।)* সব ঠিক থাকলে GitHub-এ একটা নতুন repository বানান, সব ফাইল push করুন, Repo Settings → Pages এ গিয়ে branch `main` এবং folder `/root` সিলেক্ট করে Save করুন। কিছুক্ষণ পর একটা live link পাবেন (যেমন `https://apnarnaam.github.io/repo-naam/`) — এটাই আপনার সম্পূর্ণ ফ্রি, লাইভ ওয়েবসাইট।
