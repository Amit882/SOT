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

## সেটআপ
আগের prototype-এর README-এর ধাপগুলোই এখানে প্রযোজ্য (Firebase project, Authentication, Firestore, security rules, Cloudinary, Master God UID বসানো, GitHub Pages এ পাবলিশ) — নিচে সংক্ষেপে:

1. Firebase project বানান → Authentication (Email/Password) enable করুন → Firestore Database চালু করুন
2. `firebase-config.js`-এ আপনার Firebase config + Cloudinary cloud name/preset বসান
3. একবার সাইন আপ করে নিজের UID কপি করে `firebase-config.js` ও `firestore.rules`-এ `MASTER_GOD_UID` বসান, rules Publish করুন
4. Firestore-এ নিজের user document-এ `role: master_god`, `approved: true` ম্যানুয়ালি বসান (একবারই লাগবে)
5. লোকাল টেস্ট: `python3 -m http.server 8000` → `http://localhost:8000`
6. GitHub repo বানিয়ে push করুন → Settings → Pages → branch/root বেছে দিন → লাইভ লিংক পাবেন
