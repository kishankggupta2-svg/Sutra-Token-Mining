// ============================================================
// PART 1: Firebase setup, auth, and all database read/write helpers
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, runTransaction, serverTimestamp, query, where, orderBy, limit, getAggregateFromServer, sum, count } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification, signOut, onAuthStateChanged, signInAnonymously, linkWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const app = initializeApp({
  apiKey: "AIzaSyBObs__5uwNvglPIdYjPKHh5q14Wc5F0yA",
  authDomain: "sutra-token-app.firebaseapp.com",
  projectId: "sutra-token-app",
  storageBucket: "sutra-token-app.firebasestorage.app",
  messagingSenderId: "946400061874",
  appId: "1:946400061874:web:21b54d1b367796ca391cab",
  measurementId: "G-FZ5JNE08ZB"
});
const db = getFirestore(app), auth = getAuth(app);
window.db = db; window.auth = auth;
window.fsCollection = collection; window.fsGetDocs = getDocs;
const tgId = () => window.Telegram?.WebApp?.initDataUnsafe?.user?.id;

// ---- every user (Telegram or browser) gets a real Firebase Auth session, and their
// data-doc id ("docKey") is bound to that auth uid exactly once, in userLinks/{docKey}.
// Firestore rules use that binding to make sure a user can only ever read/write their OWN doc.
window.saveUserData = async (uid, data) => {
  if (!uid) return false;
  try { await setDoc(doc(db, "users", String(uid)), { ...data, updatedAt: serverTimestamp() }, { merge: true }); return true; }
  catch (e) { console.error(e); return false; }
};
window.loadUserData = async (uid) => {
  if (!uid) return null;
  const s = await getDoc(doc(db, "users", String(uid)));
  return s.exists() ? s.data() : null;
};
window.uploadProfileImage = async (uid, file) => {
  // stored under the caller's own Auth uid, never the docKey, so Storage rules can check request.auth.uid directly
  // Storage SDK is loaded only when a photo is actually uploaded (faster app start)
  const S = await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js");
  const storage = S.getStorage(app);
  const r = S.ref(storage, `profile_pictures/${auth.currentUser.uid}/${Date.now()}_${file.name}`);
  return S.getDownloadURL((await S.uploadBytes(r, file)).ref);
};

// ---- masked, public leaderboard row: no email/photo/session data, only what ranking needs ----
window.saveLeaderboardRow = (docKey, row) => setDoc(doc(db, "leaderboard", String(docKey)), { ...row, updatedAt: serverTimestamp() }, { merge: true });

// ---- one-time, immutable ownership link: docKey -> authUid. First write wins and can never change. ----
async function ensureLink(docKey, authUid) {
  const r = doc(db, "userLinks", String(docKey));
  const existing = await getDoc(r);
  if (existing.exists()) {
    if (existing.data().authUid !== authUid) throw new Error("This account is already linked to a different session.");
    return;
  }
  await setDoc(r, { authUid, linkedAt: serverTimestamp() });
}
window.ensureLink = ensureLink;

// ---- reverse lookup: authUid -> the docKey it was originally registered under.
// Without this, a registered account would resolve to a DIFFERENT docKey depending on
// whether the current session happens to be inside Telegram or not, and cross-device
// login (the whole point of "create account") would silently load an empty account. ----
async function ensureAuthIndex(authUid, docKey) {
  const r = doc(db, "authIndex", authUid);
  const existing = await getDoc(r);
  if (existing.exists()) return existing.data().docKey;
  await setDoc(r, { docKey, linkedAt: serverTimestamp() });
  return docKey;
}
window.ensureAuthIndex = ensureAuthIndex;

// Account: Firebase Auth stores the password securely (hashed). We never store it in Firestore.
window.registerAccount = async (p) => {
  if (await window.userIdExists(p.userId)) throw new Error("This User ID is already taken. Choose another.");
  const guest = auth.currentUser && auth.currentUser.isAnonymous;
  // a guest who already mined keeps the same account (same data); otherwise create a new one
  const cred = guest ? await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(p.email, p.password))
                     : await createUserWithEmailAndPassword(auth, p.email, p.password);
  const authUid = cred.user.uid;
  const docKey = window.docKey || (tgId() ? String(tgId()) : authUid);
  try { await ensureLink(docKey, authUid); await ensureAuthIndex(authUid, docKey); } catch (e) { if (!guest) await cred.user.delete(); throw e; }
  try {
    await runTransaction(db, async (tx) => {
      const r = doc(db, "userIds", p.userId);
      if ((await tx.get(r)).exists()) throw new Error("This User ID is already taken. Choose another.");
      tx.set(r, { authUid, emailHash: await sha256(p.email.toLowerCase()) });   // never store the email itself in this readable registry
    });
  } catch (e) { if (!guest) await cred.user.delete(); throw e; }
  const old = await window.loadUserData(docKey);
  await window.saveUserData(docKey, { firstName: p.first, lastName: p.last, name: (p.first + " " + p.last).trim(),
    phone: p.phone, userId: p.userId, email: p.email.toLowerCase(), ...(old ? {} : { createdAt: serverTimestamp(), role: "user", status: "active" }) });
  try { await sendEmailVerification(cred.user); } catch (e) {}
};
const sha256 = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
window.loginAccount = async (userId, email, password) => {
  const s = await getDoc(doc(db, "userIds", userId));
  const h = await sha256(email.toLowerCase());
  if (!s.exists() || (s.data().emailHash !== h && s.data().email !== email.toLowerCase())) throw new Error("User ID, email or password is incorrect.");
  let cred;
  try { cred = await signInWithEmailAndPassword(auth, email, password); }
  catch (e) { throw new Error("User ID, email or password is incorrect."); }
  await cred.user.reload();
  if (!cred.user.emailVerified) {
    try { await sendEmailVerification(cred.user); } catch (e) {}
    await signOut(auth);
    throw new Error("Email not verified yet. We sent a new link. Open it, then log in again.");
  }
};

// ---- referrals: every write touches ONLY the caller's own document, never someone else's ----
// referrals/{referredDocKey}      -- created & updated only by the referred friend themselves
// referralClaims/{referredDocKey} -- created only by the referrer, once, to collect their own reward
window.refCreate = (referredId, referrerId) => setDoc(doc(db, "referrals", String(referredId)), { referrerId: String(referrerId), qualified: false, createdAt: serverTimestamp() });
window.refMarkQualified = (referredId) => setDoc(doc(db, "referrals", String(referredId)), { qualified: true }, { merge: true });
window.refListFor = async (myId) => {
  const s = await getDocs(query(collection(db, "referrals"), where("referrerId", "==", String(myId))));
  const a = []; s.forEach(d => a.push({ id: d.id, ...d.data() })); return a;
};
window.refClaim = (referredId, referrerId) => setDoc(doc(db, "referralClaims", String(referredId)), { referrerId: String(referrerId), claimedAt: serverTimestamp() });
window.refClaimed = async (referredId) => (await getDoc(doc(db, "referralClaims", String(referredId)))).exists();

// Atomic start: refuses if the server already has a session (running OR finished-but-unclaimed).
window.tryStartSession = (uid, ts) => runTransaction(db, async (tx) => {
  const r = doc(db, "users", String(uid)); const d = (await tx.get(r)).data() || {};
  if (d.miningStart) return { ok: false, data: d };
  tx.set(r, { miningStart: ts, pending: 0, boostLevel: 0, boostEnd: 0, lastCalc: ts, updatedAt: serverTimestamp() }, { merge: true });
  return { ok: true };
});
window.lbTop = async () => { const s = await getDocs(query(collection(db, "leaderboard"), orderBy("balance", "desc"), limit(10))); const a = []; s.forEach(d => a.push(d.data())); return a; };
window.lbStats = async () => {
  const c = collection(db, "leaderboard");
  const [t, o] = await Promise.all([ getAggregateFromServer(c, { users: count(), mined: sum("balance") }),
    getAggregateFromServer(query(c, where("lastHeartbeat", ">", Date.now() - 12e4)), { online: count() }) ]);
  return { users: t.data().users, mined: t.data().mined || 0, online: o.data().online };
};
window.resendVerification = () => sendEmailVerification(auth.currentUser);
window.logoutAccount = () => signOut(auth);
window.userIdExists = async (id) => (await getDoc(doc(db, "userIds", id))).exists();

let booted = false;
onAuthStateChanged(auth, async (u) => {
  if (!u) {
    if (booted) return;
    try { await signInAnonymously(auth); }   // every session, Telegram or browser, gets a real auth uid
    catch (e) { console.error(e); if (!booted) { booted = true; window.linkError = 'Sign-in failed (' + (e.code || e.message) + ')'; window.bootApp(null); } }
    return;
  }
  let docKey;
  if (u.isAnonymous) {
    // fresh guest/Telegram session with no registered account yet: docKey follows this device's context
    docKey = tgId() ? String(tgId()) : u.uid;
  } else {
    // a registered account: ALWAYS resolve the one true docKey it was created under, no matter
    // which device or context (Telegram vs. the Play Store app) this login is happening in —
    // this is what makes "log in with the same User ID/email/password" load the same data everywhere
    try {
      const idx = await getDoc(doc(db, "authIndex", u.uid));
      docKey = idx.exists() ? idx.data().docKey : (tgId() ? String(tgId()) : u.uid);
    } catch (e) { console.error(e); docKey = tgId() ? String(tgId()) : u.uid; }
  }
  // start loading the user's data at the same time as the ownership check (saves one full round-trip)
  window.__pre = window.loadUserData(docKey).then(d => ({ ok: true, d }), () => ({ ok: false }));
  try { await ensureLink(docKey, u.uid); window.docKey = docKey; }
  catch (e) { console.error(e); window.docKey = null; window.linkError = e.message; }
  if (!booted) { booted = true; window.bootApp(u); }
});

// ============================================================
// PART 2: App logic - mining, boosts, gifts, referrals, UI, etc.
// ============================================================
const officialGroupLink = "https://t.me/SutraTokenOfficialgroup"; window.officialGroupLink = officialGroupLink;
const BOT_USERNAME = "SutraToken_bot";   // ❤️ your bot username (no @)
const APP_SHORT_NAME = "";               // ❤️ optional: short name from BotFather /newapp. Leave "" if you set a Main Mini App
let busy=false;   // one action at a time: blocks double-taps while an ad/save is in progress
const supportLink = "https://t.me/call/WmasSD9vLGT2vzz_kOebbouFQ4w";

// ╔══════════════════════════════════════════════════════════════════════╗
// ║ ❤️❤️❤️  VIDEO ADS — PUT YOUR VIDEO LINKS HERE  ❤️❤️❤️                 ║
// ║ Paste a direct .mp4 link between the quotes. The video plays inside   ║
// ║ the app before: start mining, boosts, claim mining, daily gift.       ║
// ║ Videos play in order 1 → 2 → 3 → 4, then repeat.                      ║
// ╚══════════════════════════════════════════════════════════════════════╝
const AD_SEQUENCE = [15, 20, 25, 30];   // seconds each video must be watched (video 1, 2, 3, 4)
const AD_VIDEOS = [
  "",   // ❤️ VIDEO 1 (15s) — paste .mp4 link here, e.g. "https://yourcdn.com/ad1.mp4"
  "",   // ❤️ VIDEO 2 (20s) — paste .mp4 link here
  "",   // ❤️ VIDEO 3 (25s) — paste .mp4 link here
  ""    // ❤️ VIDEO 4 (30s) — paste .mp4 link here
];             // Empty link = a plain timer screen is shown instead of a video

// ===== VIDEO CLAIMS (10 slots, shown in the Gift tab) =====
// ❤️ PUT YOUR VIDEO URL (direct .mp4 link) in "url" for any slot. Empty url = shows "Coming soon".
// When a url is added, that slot turns into a "Watch & claim" button and the video plays inside the app.
// seconds = how long the video must be watched, reward = SUTRA given (once per slot per day).
const VIDEO_CLAIMS = Array.from({length:10}, () => ({ url:"", seconds:20, reward:100 }));   // ❤️ EDIT HERE, e.g. VIDEO_CLAIMS[0] = {url:"https://.../v1.mp4", seconds:20, reward:100}

const TOTAL_SUPPLY = 2e12, DAY = 864e5, BOOST_MS = 144e5, BASE = 2000/86400;
const BOOST_BONUS = {1:500, 2:500, 3:1000};             // extra SUTRA over the 4-hour boost window
const BOOST_DAILY_LIMIT = 2;                            // booster can be started this many times per 24h
const boostRate = () => boostLevel ? BOOST_BONUS[boostLevel]/(BOOST_MS/1000) : 0;
const $ = id => document.getElementById(id);
const dayNum = () => Math.floor((Date.now()-new Date().getTimezoneOffset()*6e4)/864e5);
function showToast(msg, kind='info'){
  const t=$('toastBox'); t.textContent=msg; t.className='toast show '+(kind==='error'?'err':'');
  clearTimeout(window._toastT); window._toastT=setTimeout(()=>t.classList.remove('show'),2600);
}
function showSuccess(title, msg){
  if(msg===undefined){ msg=title; title='Successful'; }
  const ov=$('successOv'); ov.querySelector('.ovtitle').innerText=title; $('ovMsg').innerText=msg; ov.classList.remove('done'); ov.classList.add('show');
  clearTimeout(window._ovSpin); clearTimeout(window._ovHide);
  window._ovSpin=setTimeout(()=>ov.classList.add('done'),650);
  window._ovHide=setTimeout(hideSuccess,2300);
}
function hideSuccess(){ $('successOv').classList.remove('show'); }
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('petals').innerHTML = Array.from({length:12},(_,i)=>`<ellipse cx="50" cy="20" rx="5" ry="13" transform="rotate(${i*30} 50 50)"/>`).join("");

const tg = window.Telegram?.WebApp;
if(tg){ tg.expand(); tg.ready(); try{ tg.setHeaderColor('#0b0705'); tg.setBackgroundColor('#0b0705'); tg.disableVerticalSwipes?.(); tg.setBottomBarColor?.('#0b0705'); }catch(e){} }
const tgUser = tg?.initDataUnsafe?.user;
const getUserId = () => String(window.docKey || tgUser?.id || "");

function switchTab(t){
  document.querySelectorAll('.screen').forEach(e=>e.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('on', e.dataset.t===t));
  $('s-'+t).classList.add('on');
  if(t==='earn' && loaded) renderGift();
}
const openSheet = id => $(id).style.display='flex', closeSheet = id => $(id).style.display='none';
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m) m.style.display='none'; }));

// ===== state =====
let loaded=false, profile={}, authUser=null;
let balance=0, pending=0, miningStart=0, boostLevel=0, boostEnd=0, lastCalc=Date.now();
let totalSessions=0, referralCount=0, adIndex=0, activity=[], referredBy="", claimedSessions=0, dailyStreak=0, lastDailyDay=-1, refWaiting=0, boostDay=-1, boostUses=0;
let claims=[], totalEarned=0, vidDay=-1, vidDone=[];   // saved claim history: mining, daily gift, referral rewards
let globalMined=0, globalUsers=0, onlineUsers=0, tick=0;

const snapshot = () => ({balance, pending, miningStart, boostLevel, boostEnd, lastCalc, totalSessions, referralCount, adIndex, activity, referredBy, claimedSessions, dailyStreak, lastDailyDay, boostDay, boostUses, claims, totalEarned, vidDay, vidDone});
async function saveNow(extra={}){ const u=getUserId(); if(!loaded||!u) return; await window.saveUserData(u,{...snapshot(),...extra}); pushLeaderboardRow(); }
function log(m){ activity.unshift({m, t:new Date().toLocaleString()}); activity.length=Math.min(activity.length,50); renderActivity(); }
const CLAIM_LABEL={mining:"⛏️ Mining claimed",gift:"🎁 Daily gift claimed",video:"🎬 Video reward",referral:"🤝 Referral reward"};
function addClaim(type, amt){ totalEarned+=Number(amt)||0; claims.unshift({type, amt:Number(amt), t:Date.now()}); claims.length=Math.min(claims.length,100); renderClaims(); }
function renderClaims(){
  $('alertCount').innerText = claims.length;
  const total = claims.reduce((a,c)=>a+(c.amt||0),0);
  $('claimList').innerHTML = claims.length
    ? `<div class="row" style="border-bottom:1px solid var(--line);margin-bottom:4px"><span>Total claimed</span><b class="ok">${total.toLocaleString(undefined,{maximumFractionDigits:3})} SUTRA</b></div>` +
      claims.map(c=>`<div class="item"><b>${esc(CLAIM_LABEL[c.type]||"Claimed")} · +${Number(c.amt).toLocaleString(undefined,{maximumFractionDigits:3})} SUTRA</b>${esc(new Date(c.t).toLocaleString())}</div>`).join("")
    : "No claims yet. Your claimed rewards will be saved here.";
}
function renderActivity(){
  $('activityList').innerHTML = activity.map(n=>`<div class="item"><b>${esc(n.t)}</b>${esc(n.m)}</div>`).join("") || "No activity yet";
}

// ===== profile / account =====
function displayName(){ return profile.name || tgUser?.first_name || "Miner"; }
function renderProfile(){
  const n = displayName(), pic = profile.photo ? `<img src="${esc(profile.photo)}" alt="">` : esc(n.charAt(0).toUpperCase());
  $('uName').innerText = n; $('uPic').innerHTML = pic; $('bigPic').innerHTML = pic;
  $('firstInput').value = profile.firstName || tgUser?.first_name || ""; $('lastInput').value = profile.lastName || tgUser?.last_name || "";
  const c = $('accountCard');
  const v=authUser?.emailVerified;
  if(profile.userId && authUser && v){
    c.innerHTML = `<h3>Account</h3>
      <div class="row">User ID<b>${esc(profile.userId)}</b></div>
      <div class="row">Mobile<b>${esc(profile.phone||'—')}</b></div>
      <div class="row">Email<b>${esc(profile.email)}</b></div>
      <div class="row">Status<b class="ok">✓ Verified</b></div>
      <button class="btn alt" onclick="logout()">Log out</button>`;
  } else if(profile.userId){
    c.innerHTML = `<h3>Account created</h3><p>Open the verification link we emailed you, then log in with your User ID, email and password.</p><button class="btn" onclick="showAuth('login',true)">Log in</button>`;
  } else {
    c.innerHTML = `<h3>Create account & app login</h3><p class="tagline">User ID, Email & Password — Login to Sutra Mining App</p><p>Create an account with a User ID, email and password. Use them to log in to our app and get all your mining data there.</p><button class="btn" onclick="showAuth('create',true)">Create account</button><button class="btn alt" onclick="showAuth('login',true)">Log in</button>`;
  }
}
async function saveProfile(){
  const first=$('firstInput').value.trim(), last=$('lastInput').value.trim(), f=$('picUpload').files[0], b=$('saveProfileBtn');
  if(!first){ showToast("Enter your first name","error"); return; }
  if(f && f.size>2*1024*1024){ showToast("Image must be under 2MB","error"); return; }
  if(f && !["image/jpeg","image/png"].includes(f.type)){ showToast("Only JPG or PNG allowed","error"); return; }
  b.disabled=true; b.innerText="Saving...";
  try{
    if(f) profile.photo = await window.uploadProfileImage(getUserId(), f);
    Object.assign(profile,{firstName:first,lastName:last,name:(first+" "+last).trim()});
    await window.saveUserData(getUserId(),{firstName:first,lastName:last,name:profile.name,photo:profile.photo||""});
    renderProfile(); showSuccess("Profile saved");
  }catch(e){ showToast("Could not save: "+e.message,"error"); }
  finally{ b.disabled=false; b.innerText="Save profile"; $('picUpload').value=""; }
}
async function savePhoto(){
  const f=$('picUpload').files[0]; if(!f) return;
  if(f.size>2*1024*1024){ showToast("Image must be under 2MB","error"); $('picUpload').value=""; return; }
  if(!["image/jpeg","image/png"].includes(f.type)){ showToast("Only JPG or PNG allowed","error"); $('picUpload').value=""; return; }
  $('bigPic').style.opacity=.5;
  try{
    profile.photo=await window.uploadProfileImage(getUserId(),f);
    await window.saveUserData(getUserId(),{photo:profile.photo});
    renderProfile(); showToast("Photo updated");
  }catch(e){ showToast("Could not upload photo: "+e.message,"error"); }
  finally{ $('bigPic').style.opacity=1; $('picUpload').value=""; }
}
async function resendVerify(){ try{ await window.resendVerification(); showSuccess("Verification email sent","Check your inbox."); }catch(e){ showToast(e.message,"error"); } }
async function logout(){ await saveNow(); await window.logoutAccount(); location.reload(); }

// ===== create account -> verify -> log in =====
function showAuth(step, closable){
  $('authBox').style.display='block'; $('authClose').style.display=closable?'block':'none';
  $('accountCard').style.display='none';
  authStep(step); switchTab('profile');
}
function hideAuth(){ $('authBox').style.display='none'; $('accountCard').style.display='block'; }
function authStep(st){ ['Create','Sent','Login'].forEach(n=>$('st'+n).style.display = n.toLowerCase()===st?'block':'none'); }
function genUserId(){
  const r=()=>crypto.getRandomValues(new Uint32Array(1))[0], len=8+(r()%3);
  let id=String(1+r()%9); while(id.length<len) id+=r()%10;
  $('cUserId').value=id;
}
async function verifyAccount(){
  const err=$('cErr'), b=$('verifyBtn'), first=$('cFirst').value.trim(), last=$('cLast').value.trim(),
        phone=$('cPhone').value.trim().replace(/[\s-]/g,""), id=$('cUserId').value.trim(), email=$('cEmail').value.trim(), pw=$('cPass').value;
  err.innerText='';
  if(!first){ err.innerText='Enter your first name.'; return; }
  if(!/^\+?\d{8,15}$/.test(phone)){ err.innerText='Enter a valid mobile number.'; return; }
  if(!/^\d{8,10}$/.test(id)){ err.innerText='User ID must be 8 to 10 digits.'; return; }
  if(!/^\S+@\S+\.\S+$/.test(email)){ err.innerText='Enter a valid email.'; return; }
  if(pw.length<8){ err.innerText='Password must be at least 8 characters.'; return; }
  if(pw!==$('cPass2').value){ err.innerText='Passwords do not match.'; return; }
  b.disabled=true; b.innerText='Please wait...';
  try{
    await window.registerAccount({first,last,phone,userId:id,email,password:pw});
    $('sentText').innerText=`We sent a verification link to ${email}. Open it, then log in with your User ID, email and password.`;
    $('lUserId').value=id; $('lEmail').value=email; authStep('sent');
  }catch(e){ err.innerText = e.code==='auth/email-already-in-use' ? 'This email is already registered. Log in instead.' : e.message; }
  finally{ b.disabled=false; b.innerText='Verify account'; }
}
async function doLogin(){
  const err=$('lErr'), b=$('loginBtn'), id=$('lUserId').value.trim(), email=$('lEmail').value.trim(), pw=$('lPass').value;
  err.innerText='';
  if(!/^\d{8,10}$/.test(id) || !email || !pw){ err.innerText='Enter your User ID, email and password.'; return; }
  b.disabled=true; b.innerText='Please wait...';
  try{ await window.loginAccount(id,email,pw); location.reload(); }
  catch(e){ err.innerText=e.message; b.disabled=false; b.innerText='Log in'; }
}

// ===== mining =====
function settle(now=Date.now()){
  if(!miningStart){ lastCalc=now; return; }
  const t0=Math.max(lastCalc,miningStart), t1=Math.min(now,miningStart+DAY);
  if(t1>t0){
    let bs=0;
    if(boostLevel>0) bs=Math.max(0,Math.min(t1,boostEnd)-Math.max(t0,boostEnd-BOOST_MS))/1000;
    const secs=(t1-t0)/1000;
    pending += BASE*(secs-bs) + (BASE+boostRate())*bs;
    if(balance+pending>TOTAL_SUPPLY) pending=Math.max(0,TOTAL_SUPPLY-balance);
  }
  lastCalc=now;
  if(boostLevel>0 && now>=boostEnd){ log(`🚀 Boost ended (was ${["2x","3x","4x"][boostLevel-1]})`); boostLevel=0; }
}
const mState = (now=Date.now()) => !miningStart ? 'idle' : now<miningStart+DAY ? 'mining' : 'done';
const fmt = ms => `${Math.floor(ms/36e5)}h ${Math.floor(ms%36e5/6e4)}m ${Math.floor(ms%6e4/1e3)}s`;
const RANKS=[[1e6,"👑 Legend Miner"],[5e5,"💎 Diamond Miner"],[1e5,"🥇 Gold Miner"],[5e4,"🥈 Silver Miner"],[1e4,"🥉 Bronze Miner"],[0,"🪨 New Miner"]];
const getRank = b => RANKS.find(r=>b>=r[0])[1];

function render(){
  const now=Date.now(), st=mState(now), total=balance+pending;
  $('tokenBalance').innerText=total.toFixed(3); $('modalTokenBal').innerText=total.toFixed(3); $('wTotal').innerText=total.toFixed(3);
  $('sessionEarn').innerText=pending.toFixed(3)+" SUTRA"; $('walletPending').innerText=pending.toFixed(3); $('walletPending2').innerText=pending.toFixed(3);
  $('walletSessions').innerText=totalSessions; $('walletReferrals').innerText=referralCount; $('refCount2').innerText=referralCount;
  $('wTotal').innerText=(totalEarned+pending).toFixed(3);
  $('wJoined').innerText=globalUsers.toLocaleString(); $('wOnline').innerText=onlineUsers;
  { const _b = boostLevel>0 && now<boostEnd; $('wMining').innerHTML = st==='mining' ? `<span class="ok">🟢 Live · ${Math.round((BASE+(_b?boostRate():0))*3600).toLocaleString()}/hr</span>` : st==='done' ? '<span class="ok">✅ Ready to claim</span>' : '<span class="bad">🔴 Stopped</span>'; }
  $('rankBox').innerText=getRank(total); $('refWaiting').innerText=refWaiting;
  const boosting = boostLevel>0 && now<boostEnd;
  $('rateHr').innerText = st==='mining' ? Math.round((BASE+(boosting?boostRate():0))*3600).toLocaleString() : "0";
  { const wl=$('wMineLeft'), ws=$('wMineStatus'), wb=$('wMineBoost');
    if(st==='mining'){ ws.innerHTML='<span class="ok">🟢 Mining active</span>'; wl.innerText=fmt(miningStart+DAY-now)+' left'; wb.innerText=boosting?`${["2x","3x","4x"][boostLevel-1]} boost · ${fmt(boostEnd-now)} left`:'No boost running'; }
    else if(st==='done'){ ws.innerHTML='<span class="ok">✅ Completed</span>'; wl.innerText='Ready to claim'; wb.innerText='Go to Mine tab to claim'; }
    else { ws.innerHTML='<span class="bad">🔴 Stopped</span>'; wl.innerText='—'; wb.innerText='Start mining from the Mine tab'; } }
  const btn=$('mineBtn'), hero=$('hero');
  hero.classList.toggle('on-air',st==='mining'); btn.classList.toggle('live',st!=='idle'); btn.classList.toggle('idle',st==='idle');
  btn.disabled = st==='mining';
  if(st==='mining'){
    const left=miningStart+DAY-now;
    $('mineIcon').innerText="⛏️"; $('mineText').innerText="Mining"; $('mineSubText').innerText=fmt(left)+" left";
    $('ringFg').style.strokeDashoffset=283*(left/DAY); $('miningStatusBox').innerHTML='<span class="ok">🟢 Active</span>';
  } else if(st==='done'){
    $('mineIcon').innerText="🎁"; $('mineText').innerText="Claim"; $('mineSubText').innerText=pending.toFixed(2)+" SUTRA";
    $('ringFg').style.strokeDashoffset=0; $('miningStatusBox').innerHTML='<span class="ok">✅ Completed</span>';
  } else {
    $('mineIcon').innerText="ॐ"; $('mineText').innerText="Start mining"; $('mineSubText').innerText="Watch a video to begin";
    $('ringFg').style.strokeDashoffset=283; $('miningStatusBox').innerHTML='<span class="bad">🔴 Stopped</span>';
  }
  const labels=["2x","3x","4x"];
  for(let n=1;n<=3;n++){
    const b=$('b'+n), act=boostLevel>=n;
    b.classList.toggle('act',act); b.disabled = act || !(st==='mining' && boostLevel===n-1);
    b.querySelector('small').innerText = act ? `+${BOOST_BONUS[n]}` : (st==='mining' && boostLevel===n-1 ? "Watch video" : "Locked");
  }
  const usesLeft = Math.max(0, BOOST_DAILY_LIMIT-(boostDay===dayNum()?boostUses:0));
  $('boostInfo').innerText = boostLevel>0 ? `${labels[boostLevel-1]} boost ends in ${fmt(boostEnd-now)}. Next boosts share this timer.` : `Unlock 2x, then 3x, then 4x — each needs a video. ${usesLeft} of ${BOOST_DAILY_LIMIT} boosts left today.`;
  const pct=globalMined/TOTAL_SUPPLY*100;
  $('globalProgressFill').style.width=pct+'%';
  $('globalMeterText').innerText=(pct>0&&pct<0.01?'<0.01':pct.toFixed(pct<1?2:1))+'% mined so far';
}
function loop(){
  settle(); render();
  // local display updates every second; the write to Firebase happens far less often (see boot) to stay stable at high user counts
}

async function dialAction(){ if(busy) return; busy=true; try{ await dialInner(); } finally{ busy=false; } }
async function dialInner(){
  if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
  if(!getUserId()){ showToast(window.linkError?'Could not connect — see Profile for details':'Please log in from the Profile tab first.','error'); switchTab('profile'); return; }
  const st=mState();
  if(st==='done'){
    try{ await playAd(); }catch(e){ return; }
    if(mState()!=='done') return;
    settle(); const claimed=pending; balance+=pending; claimedSessions++; log(`✅ Claimed ${claimed.toFixed(3)} SUTRA`); addClaim('mining',claimed); pending=0; miningStart=0; boostLevel=0; boostEnd=0;
    await saveNow(); render(); showSuccess(`${claimed.toFixed(3)} SUTRA added to your balance`);
    if(referredBy && claimedSessions>=2) window.refMarkQualified(getUserId()).catch(()=>{});
    return;
  }
  if(st!=='idle') return;
  if(globalMined>=TOTAL_SUPPLY){ showToast("Total supply has been fully mined.","error"); return; }
  try{ await playAd(); }catch(e){ return; }
  const ts=Date.now(); let r;
  try{ r=await window.tryStartSession(getUserId(), ts); }catch(e){ showToast("Could not start. Check your connection.","error"); return; }
  if(!r.ok){   // a session already exists on the server (e.g. started from another tab/device) — adopt it, never start a second one
    const d=r.data; miningStart=d.miningStart; pending=Math.max(pending,d.pending||0); lastCalc=d.lastCalc||miningStart; boostLevel=d.boostLevel||0; boostEnd=d.boostEnd||0;
    showToast("Mining is already running. Next session starts after 24 hours.","error"); render(); return;
  }
  miningStart=ts; lastCalc=ts; pending=0; boostLevel=0; boostEnd=0; totalSessions++;
  log("⛏️ 24-hour mining started"); await saveNow(); render();
}
async function handleBooster(n){ if(busy) return; busy=true; try{ await boosterInner(n); } finally{ busy=false; } }
async function boosterInner(n){
  if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
  if(!getUserId()){ showToast(window.linkError?'Could not connect — see Profile for details':'Please log in from the Profile tab first.','error'); switchTab('profile'); return; }
  if(mState()!=='mining' || boostLevel!==n-1) return;
  if(boostDay!==dayNum()){ boostDay=dayNum(); boostUses=0; }
  if(n===1 && boostUses>=BOOST_DAILY_LIMIT){ showToast(`You can use the booster only ${BOOST_DAILY_LIMIT} times a day. Try again tomorrow.`,'error'); return; }
  try{ await playAd(); }catch(e){ return; }
  settle();                                    // close the previous rate first
  if(mState()!=='mining' || boostLevel!==n-1) return;
  if(n===1){ boostEnd=Date.now()+BOOST_MS; boostUses++; }   // 3x and 4x share the 2x timer and don't count as a new use
  boostLevel=n; log(`🚀 ${['2x','3x','4x'][n-1]} boost activated (+${BOOST_BONUS[n]} SUTRA / 4h)`); await saveNow(); render();
}

// ===== video ads =====
function playAd(custom){
  return new Promise((resolve,reject)=>{
    const i=adIndex%AD_SEQUENCE.length, secs=custom?custom.secs:AD_SEQUENCE[i], url=custom?custom.url:AD_VIDEOS[i];
    const box=$('adBox'), v=$('adVideo'); let left=secs, done=false;
    v.style.display=url?'block':'none'; $('adPh').style.display=url?'none':'block';
    if(url){ v.src=url; v.play().catch(()=>{}); }
    box.style.display='flex';
    $('adClose').innerText="Cancel"; $('adBar').style.width="0";
    const finish=(ok)=>{ clearInterval(t); v.pause(); v.removeAttribute('src'); box.style.display='none'; $('adClose').onclick=null; if(ok){ if(!custom) adIndex++; resolve(); } else reject(); };
    const paint=()=>{ $('adText').innerText=`Reward in ${left}s`; $('adBar').style.width=((secs-left)/secs*100)+'%'; };
    paint();
    const t=setInterval(()=>{ if(document.hidden) return; left--; paint(); if(left<=0){ done=true; $('adText').innerText="Done"; $('adClose').innerText="Get reward"; clearInterval(t); } },1000);
    $('adClose').onclick=()=>finish(done);
  });
}

// ===== rewards / referral =====
function nextGiftDay(){ const t=dayNum(); if(lastDailyDay===t) return 0; let n=(lastDailyDay===t-1)?dailyStreak+1:1; return n>30?1:n; }
function renderGift(){
  const t=dayNum(), live=lastDailyDay>=t-1?dailyStreak:0, nx=nextGiftDay(); let h="";
  for(let n=1;n<=30;n++) h+=`<div class="gd ${n<=live&&!(nx===1&&live===30)?'done':''} ${n===nx?'now':''}">Day ${n}<b>${n*100}</b></div>`;
  $('giftGrid').innerHTML=h; const b=$('giftBtn');
  b.disabled=!nx; b.innerText = nx ? `Watch video & claim ${nx*100} SUTRA` : "Claimed today. Come back tomorrow";
}
async function claimDailyReward(){ if(busy) return; busy=true; try{ await giftInner(); } finally{ busy=false; } }
async function giftInner(){
  if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
  if(!getUserId()){ showToast(window.linkError?'Could not connect — see Profile for details':'Please log in from the Profile tab first.','error'); switchTab('profile'); return; }
  const day=nextGiftDay(); if(!day){ showToast("Already claimed today. Come back tomorrow."); return; }
  const streakBroken = day===1 && dailyStreak>1;
  try{ await playAd(); }catch(e){ return; }
  if(!nextGiftDay()) return;
  if(streakBroken) log(`⏳ Daily gift streak expired after Day ${dailyStreak} — restarting from Day 1`);
  balance+=day*100; dailyStreak=day; lastDailyDay=dayNum(); log(`🎁 Day ${day} gift claimed (${day*100} SUTRA)`); addClaim('gift',day*100);
  await saveNow(); renderGift(); render(); showSuccess(`Day ${day} gift claimed: ${(day*100).toLocaleString()} SUTRA`);
}
function renderVideos(){
  const today = vidDay===dayNum(), doneList = today ? vidDone : [];
  $('vidList').innerHTML = VIDEO_CLAIMS.map((v,i)=>{
    const n=i+1;
    if(!v.url) return `<div class="vrow"><span>🎬 Video claim ${n}</span><em>Coming soon</em></div>`;
    if(doneList.includes(i)) return `<div class="vrow"><span>🎬 Video claim ${n}</span><em class="ok">✓ Claimed today</em></div>`;
    return `<div class="vrow"><span>🎬 Video claim ${n}</span><button class="vbtn" onclick="claimVideo(${i})">Watch & claim +${v.reward}</button></div>`;
  }).join("");
}
async function claimVideo(i){
  if(busy) return; busy=true;
  try{
    if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
    if(!loaded){ showToast('Could not connect — see Profile for details','error'); return; }
    const v=VIDEO_CLAIMS[i]; if(!v||!v.url) return;
    if(vidDay!==dayNum()){ vidDay=dayNum(); vidDone=[]; }
    if(vidDone.includes(i)){ showToast("Already claimed today. Come back tomorrow."); return; }
    try{ await playAd({secs:v.seconds, url:v.url}); }catch(e){ return; }
    if(vidDay!==dayNum()){ vidDay=dayNum(); vidDone=[]; }
    if(vidDone.includes(i)) return;
    balance+=v.reward; vidDone.push(i); log(`🎬 Video ${i+1} reward claimed (${v.reward} SUTRA)`); addClaim('video',v.reward);
    await saveNow(); renderVideos(); render(); showSuccess(`Video reward: ${v.reward.toLocaleString()} SUTRA`);
  } finally{ busy=false; }
}
async function pushLeaderboardRow(){
  if(!getUserId()) return;
  const total=balance+pending;
  try{ await window.saveLeaderboardRow(getUserId(), {
    name: (profile.name||"Miner").substring(0,3)+"***", balance: total, rank: getRank(total),
    online: !document.hidden, lastHeartbeat: Date.now()
  }); }catch(e){}
}
async function loadLeaderboard(){
  try{
    const [top, st] = await Promise.all([window.lbTop(), window.lbStats()]);
    globalUsers=st.users; globalMined=st.mined; onlineUsers=st.online;
    $('leaderboardList').innerHTML=top.map((x,i)=>`<div class="lb"><div>#${i+1} ${esc(x.name||"Miner")}<small>${esc(x.rank||getRank(x.balance||0))}</small></div><b class="s">${(x.balance||0).toFixed(0)}</b></div>`).join("")||"No users yet";
  }catch(e){ $('leaderboardList').innerText="Leaderboard unavailable"; }
}
async function loadAnnouncements(){
  try{
    const snap=await window.fsGetDocs(window.fsCollection(window.db,"announcements")); let a=[];
    snap.forEach(d=>a.push(d.data())); a.sort((x,y)=>(y.date||0)-(x.date||0));
    $('announcementList').innerHTML=a.filter(i=>i.active===true).map(i=>`<div class="item"><b style="color:var(--saffron);font-size:14px">${esc(i.title||"Announcement")}</b>${esc(i.message||"")}</div>`).join("")||"No active announcements.";
  }catch(e){ $('announcementList').innerText="Announcements unavailable"; }
}

const PLAY_STORE_LINK = "";   // ❤️ PUT YOUR PLAY STORE LINK HERE when the app is live
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); showToast("Copied to clipboard"); return; }catch(e){}
  $('shareTextBox').value=t; openSheet('shareModal');
}
function setupShare(){
  const refLink = APP_SHORT_NAME ? `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=ref_${getUserId()}` : `https://t.me/${BOT_USERNAME}?startapp=ref_${getUserId()}`;
  const msg=`🚀 Mine $SUTRA free! Join with my link and start earning.`;
  const text=`${msg}\n${refLink}`+(PLAY_STORE_LINK?`\n\nGet the app: ${PLAY_STORE_LINK}`:"");
  window.shareApp=async()=>{
    if(navigator.share){ try{ await navigator.share({title:'Sutra Token Mining',text}); return; }catch(e){ if(e.name==='AbortError') return; } }
    if(tg?.openTelegramLink){ tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(msg)}`); return; }
    copyText(text);
  };
  window.copyRef=()=>copyText(text);
}
async function checkReferrals(){
  // reads "referrals" docs where referrerId==me (read-only, no field is sensitive), then
  // claims each qualified friend exactly once via referralClaims/{friendId} — a document
  // this account owns and writes itself, so no cross-user write is ever needed.
  if(!loaded) return;
  try{
    const list=await window.refListFor(getUserId()); let wait=0, changed=false;
    for(const r of list){
      if(!r.qualified) { wait++; continue; }
      if(await window.refClaimed(r.id)) continue;
      try{
        await window.refClaim(r.id, getUserId());
        balance+=500; referralCount++; changed=true; log("🤝 500 SUTRA referral reward: your friend completed 2 sessions"); addClaim('referral',500);
      }catch(e){}   // someone/something already claimed this friend — skip silently
    }
    refWaiting=wait; if(changed) await saveNow(); render();
  }catch(e){}
}
function openSupport(){ tg?.openTelegramLink ? tg.openTelegramLink(supportLink) : window.open(supportLink,"_blank"); }

// ===== boot (called by the Firebase module once auth state is known) =====
function bootFail(detail){
  const sc=$('secCheck'); if(sc) sc.remove();
  const b=$('mineBtn'); if(!b) return;
  $('mineIcon').innerText="⚠️"; $('mineText').innerText="Not connected"; $('mineSubText').innerText="Tap to retry";
  b.disabled=false; b.onclick=()=>location.reload();
  const d=String(detail||"unknown"), H=[
    [/operation-not-allowed|admin-restricted/,"Firebase Console → Authentication → Sign-in method → turn ON \"Anonymous\"."],
    [/permission-denied|Missing or insufficient/,"Firebase Console → Firestore Database → Rules → paste firestore.rules → Publish."],
    [/unauthorized-domain/,"Firebase Console → Authentication → Settings → Authorized domains → add your Render domain."],
    [/offline|unavailable|network/,"Network problem or Firestore not created. Check internet, and that a Firestore Database exists."]];
  const hint=(H.find(h=>h[0].test(d))||[0,"Check Firebase setup: Anonymous sign-in ON, Firestore rules published."])[1];
  const c=$('connErr'); if(c){ c.style.display='block'; c.innerHTML=`<h3 style="color:var(--lotus)">⚠️ Could not connect</h3><p><b>Error:</b> ${esc(d)}</p><p>${esc(hint)}</p>`; }
}
window.bootApp = async function(au){
  authUser=au; const uid=getUserId();
  if(window.linkError){
    $('accountCard').innerHTML = `<h3 style="color:var(--lotus)">⚠️ Could not connect</h3>
      <p>${esc(window.linkError)}</p>
      <p>If this is your first time testing: open Firebase Console → Authentication → Sign-in method → enable <b>Anonymous</b>, and make sure the Firestore & Storage rules have been published.</p>
      <button class="btn alt" onclick="location.reload()">Retry</button>`;
    showToast('Could not connect — see Profile for details','error'); bootFail(window.linkError); return;
  }
  if(!uid){ showAuth('login',false); return; }        // Play Store / browser: must log in
  let d=null;
  try{ const pre = window.__pre ? await window.__pre : { ok:false }; d = pre.ok ? pre.d : await window.loadUserData(uid); }catch(e){ showToast("Could not load your data. Check your connection and reopen the app.","error"); bootFail("Data load failed: "+(e.code||e.message)); return; }
  d=d||{}; profile=d;
  balance=Math.max(0,d.balance||0); pending=Math.max(0,d.pending||0); miningStart=d.miningStart||0;
  boostLevel=d.boostLevel||0; boostEnd=d.boostEnd||0; lastCalc=d.lastCalc||Date.now();
  totalSessions=d.totalSessions||0; referralCount=d.referralCount||0; adIndex=d.adIndex||0; activity=d.activity||[]; claims=Array.isArray(d.claims)?d.claims:[]; totalEarned=(typeof d.totalEarned==='number')?d.totalEarned:balance; vidDay=(d.vidDay ?? -1); vidDone=Array.isArray(d.vidDone)?d.vidDone:[];
  referredBy=d.referredBy||""; claimedSessions=d.claimedSessions||0; dailyStreak=d.dailyStreak||0; lastDailyDay=(d.lastDailyDay ?? -1);
  boostDay=(d.boostDay ?? -1); boostUses=d.boostUses||0;
  if(tgUser && !d.name){ profile.name=(tgUser.first_name+" "+(tgUser.last_name||"")).trim(); profile.firstName=tgUser.first_name; profile.lastName=tgUser.last_name||""; }
  loaded=true; window.__ready=true; const sc=$('secCheck'); if(sc) sc.remove();
  const firstTime = !d.seenWelcome;
  const sp=tg?.initDataUnsafe?.start_param;
  if(sp?.startsWith('ref_') && !d.referredBy){
    const refId=sp.slice(4);
    if(refId && refId!==uid){
      referredBy=refId;
      try{ await window.saveUserData(uid,{referredBy:refId}); await window.refCreate(uid,refId); }catch(e){}
    }
    setTimeout(()=>switchTab('friends'),50);   // came in via a referral link — jump straight to Friends
  }
  settle();                                          // credit earnings made while the app was closed
  saveNow(firstTime?{seenWelcome:true}:{});
  renderProfile(); renderActivity(); renderClaims(); setupShare(); render();
  if(firstTime) openSheet('welcomeModal');
  loadAnnouncements(); loadLeaderboard();
  renderGift(); renderVideos(); checkReferrals();
  setInterval(loop,1000); setInterval(loadLeaderboard,60000); setInterval(checkReferrals,60000);
  // single periodic write to Firebase (balance/session/online state), spread out so a huge number of
  // concurrent users never floods Firestore with per-second writes
  setInterval(()=>{ if(!document.hidden){ settle(); saveNow({online:true,lastHeartbeat:Date.now()}); } },30000);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden){ settle(); saveNow({online:false,lastHeartbeat:0}); } else { settle(); render(); } });
  window.addEventListener('pagehide',()=>{ settle(); saveNow({online:false,lastHeartbeat:0}); });
};

Object.assign(window,{ claimVideo, authStep, claimDailyReward, closeSheet, dialAction, doLogin, genUserId, handleBooster, hideAuth, hideSuccess,
  openSheet, openSupport, savePhoto, saveProfile, switchTab, verifyAccount, showAuth, logout });

window.__appLoaded = true;
