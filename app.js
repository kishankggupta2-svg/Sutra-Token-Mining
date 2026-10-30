// ============================================================
// PART 1: Firebase setup, auth, and all database read/write helpers
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, runTransaction, serverTimestamp, query, where, orderBy, limit, getAggregateFromServer, sum, count } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification, signOut, onAuthStateChanged, signInAnonymously, linkWithCredential, EmailAuthProvider, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

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

// every user gets a real Firebase Auth session; their data-doc id ("docKey") is bound to the auth uid in userLinks/{docKey}
window.saveUserData = async (uid, data) => {
  if (!uid) return false;
  try { await setDoc(doc(db, "users", String(uid)), { ...(window.__hasFirstSeen ? {} : { firstSeen: serverTimestamp() }), ...data, updatedAt: serverTimestamp() }, { merge: true }); window.__hasFirstSeen = true; return true; }
  catch (e) { console.error(e); return false; }
};
window.loadUserData = async (uid) => {
  if (!uid) return null;
  const s = await getDoc(doc(db, "users", String(uid)));
  if (s.exists() && s.data().firstSeen) window.__hasFirstSeen = true;
  return s.exists() ? s.data() : null;
};
window.uploadProfileImage = async (uid, file) => {
  const S = await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-storage.js");
  const storage = S.getStorage(app);
  const r = S.ref(storage, `profile_pictures/${auth.currentUser.uid}/${Date.now()}_${file.name}`);
  return S.getDownloadURL((await S.uploadBytes(r, file)).ref);
};

window.saveLeaderboardRow = (docKey, row) => setDoc(doc(db, "leaderboard", String(docKey)), { ...row, updatedAt: serverTimestamp() }, { merge: true });

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

async function ensureAuthIndex(authUid, docKey) {
  const r = doc(db, "authIndex", authUid);
  const existing = await getDoc(r);
  if (existing.exists()) return existing.data().docKey;
  await setDoc(r, { docKey, linkedAt: serverTimestamp() });
  return docKey;
}
window.ensureAuthIndex = ensureAuthIndex;

window.registerAccount = async (p) => {
  if (await window.userIdExists(p.userId)) throw new Error("This User ID is already taken. Choose another.");
  const guest = auth.currentUser && auth.currentUser.isAnonymous;
  const cred = guest ? await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(p.email, p.password))
                     : await createUserWithEmailAndPassword(auth, p.email, p.password);
  const authUid = cred.user.uid;
  const docKey = window.docKey || (tgId() ? String(tgId()) : authUid);
  try { await ensureLink(docKey, authUid); await ensureAuthIndex(authUid, docKey); } catch (e) { if (!guest) await cred.user.delete(); throw e; }
  try {
    await runTransaction(db, async (tx) => {
      const r = doc(db, "userIds", p.userId);
      if ((await tx.get(r)).exists()) throw new Error("This User ID is already taken. Choose another.");
      tx.set(r, { authUid, emailHash: await sha256(p.email.toLowerCase()) });
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

// referrals: every write touches ONLY the caller's own document
window.refCreate = (referredId, referrerId) => setDoc(doc(db, "referrals", String(referredId)), { referrerId: String(referrerId), qualified: false, createdAt: serverTimestamp() });
window.refEnsure = async (referredId, referrerId) => { const r = doc(db, "referrals", String(referredId)); if (!(await getDoc(r)).exists()) await setDoc(r, { referrerId: String(referrerId), qualified: false, createdAt: serverTimestamp() }); };
window.refMarkQualified = (referredId) => setDoc(doc(db, "referrals", String(referredId)), { qualified: true }, { merge: true });
window.refListFor = async (myId) => {
  const s = await getDocs(query(collection(db, "referrals"), where("referrerId", "==", String(myId))));
  const a = []; s.forEach(d => a.push({ id: d.id, ...d.data() })); return a;
};
window.refClaim = (referredId, referrerId) => setDoc(doc(db, "referralClaims", String(referredId)), { referrerId: String(referrerId), claimedAt: serverTimestamp() });
window.refClaimed = async (referredId) => (await getDoc(doc(db, "referralClaims", String(referredId)))).exists();

window.tryStartSession = (uid, ts) => runTransaction(db, async (tx) => {
  const r = doc(db, "users", String(uid)); const d = (await tx.get(r)).data() || {};
  if (d.miningStart) return { ok: false, data: d };
  tx.set(r, { miningStart: ts, pending: 0, boostLevel: 0, boostEnd: 0, lastCalc: ts, updatedAt: serverTimestamp() }, { merge: true });
  return { ok: true };
});
window.lbTop = async () => { const s = await getDocs(query(collection(db, "leaderboard"), orderBy("balance", "desc"), limit(10))); const a = []; s.forEach(d => a.push(d.data())); return a; };
window.lbTopRef = async () => { const s = await getDocs(query(collection(db, "leaderboard"), orderBy("refs", "desc"), limit(10))); const a = []; s.forEach(d => a.push(d.data())); return a; };
window.lbStats = async () => {
  const c = collection(db, "leaderboard");
  const [t, o] = await Promise.all([ getAggregateFromServer(c, { users: count(), mined: sum("balance") }),
    getAggregateFromServer(query(c, where("lastHeartbeat", ">", Date.now() - 12e4)), { online: count() }) ]);
  return { users: t.data().users, mined: t.data().mined || 0, online: o.data().online };
};
window.sendReset = (email) => sendPasswordResetEmail(auth, email);
window.socialClaimed = async (docKey, id) => (await getDoc(doc(db, "socialClaims", docKey + "_" + id))).exists();
window.socialClaim = (docKey, id) => setDoc(doc(db, "socialClaims", docKey + "_" + id), { docKey: String(docKey), id, at: serverTimestamp() });
window.resendVerification = () => sendEmailVerification(auth.currentUser);
window.logoutAccount = () => signOut(auth);
window.userIdExists = async (id) => (await getDoc(doc(db, "userIds", id))).exists();

let booted = false;
onAuthStateChanged(auth, async (u) => {
  if (!u) {
    if (booted) return;
    try { await signInAnonymously(auth); }
    catch (e) { console.error(e); if (!booted) { booted = true; window.linkError = 'We could not connect. Please check your internet and try again.'; window.bootApp(null); } }
    return;
  }
  let docKey;
  if (u.isAnonymous) {
    docKey = tgId() ? String(tgId()) : u.uid;
  } else {
    try {
      const idx = await getDoc(doc(db, "authIndex", u.uid));
      docKey = idx.exists() ? idx.data().docKey : (tgId() ? String(tgId()) : u.uid);
    } catch (e) { console.error(e); docKey = tgId() ? String(tgId()) : u.uid; }
  }
  window.__pre = window.loadUserData(docKey).then(d => ({ ok: true, d }), () => ({ ok: false }));
  try { await ensureLink(docKey, u.uid); window.docKey = docKey; }
  catch (e) { console.error(e); window.docKey = null; window.linkError = e.message; }
  if (!booted) { booted = true; window.bootApp(u); }
});

// ============================================================
// PART 2: App logic - mining, boosts, tap, gifts, social claims, referrals, UI
// ============================================================
const officialGroupLink = "https://t.me/SutraTokenOfficialgroup"; window.officialGroupLink = officialGroupLink;
const BOT_USERNAME = "SutraToken_bot";
const APP_SHORT_NAME = "";
let busy=false;
const supportLink = "https://t.me/SutraTokenMiningOfficial";

// ===== VIDEO ADS: paste direct .mp4 links. Videos play in order 1→2→3→4 then repeat. Empty link = plain timer screen. =====
const AD_SEQUENCE = [15, 20, 25, 30];
const AD_VIDEOS = [
  "",   // VIDEO 1 (15s)
  "",   // VIDEO 2 (20s)
  "",   // VIDEO 3 (25s)
  ""    // VIDEO 4 (30s)
];

// ===== VIDEO LINKS PER CLAIM: paste a direct .mp4 link for any place below. =====
// Empty = the 4 videos above are used in rotation (15s → 20s → 25s → 30s, then repeat).
const AD_SLOTS = {
  start:     "",   // before a 24-hour mining session starts
  claim:     "",   // before claiming a finished mining session
  boost:     "",   // 2x / 3x / 4x booster
  fuel:      "",   // Fuel 2x
  gift:      "",   // Daily gift
  checkin:   "",   // Daily check-in
  challenge: "",   // Daily challenges
  referral:  "",   // Referral level claim
  social:    ""    // Social claims (Telegram, YouTube, Instagram, ...)
};

// ===== SOCIAL CLAIMS: +100 SUTRA each, once per task, after the 15/20/25/30s video. Put your real links in "url". =====
const SOCIAL_REWARD = 100;
const IC={
 instagram:`<svg viewBox="0 0 32 32"><defs><linearGradient id="igr" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".4" stop-color="#fa7e1e"/><stop offset=".7" stop-color="#d62976"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#igr)"/><rect x="8" y="8" width="16" height="16" rx="5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="4" fill="none" stroke="#fff" stroke-width="2"/><circle cx="21.2" cy="10.8" r="1.2" fill="#fff"/></svg>`,
 facebook:`<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#1877f2"/><path d="M17.6 26v-8.8h3l.5-3.5h-3.5v-2.2c0-1 .3-1.7 1.8-1.7h1.8V6.7c-.3 0-1.4-.1-2.6-.1-2.6 0-4.3 1.6-4.3 4.4v2.7h-3v3.5h3V26z" fill="#fff"/></svg>`,
 youtube:`<svg viewBox="0 0 32 32"><rect y="6" width="32" height="20" rx="6" fill="#f00"/><path d="M13 11.5v9l8-4.5z" fill="#fff"/></svg>`,
 twitter:`<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#000"/><path d="M9 9l14 14M23 9L9 23" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`,
 telegram:`<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#229ed9"/><path d="M7 15.6l16.4-6.3c.8-.3 1.5.2 1.2 1.4l-2.8 13.1c-.2.9-.8 1.1-1.5.7l-4.2-3.1-2 2c-.2.2-.4.4-.8.4l.3-4.3 7.8-7c.3-.3-.1-.5-.5-.2l-9.6 6-4.1-1.3c-.9-.3-.9-.9.2-1.3z" fill="#fff"/></svg>`,
 support:`<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#ff7a1a"/><path d="M8.5 17v-1.5a7.5 7.5 0 0 1 15 0V17" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><rect x="7" y="16.5" width="4" height="6.5" rx="2" fill="#fff"/><rect x="21" y="16.5" width="4" height="6.5" rx="2" fill="#fff"/><path d="M23 23c0 2.2-2 3.2-5 3.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="17.5" cy="26.2" r="1.6" fill="#fff"/></svg>`};
IC.tggroup=`<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#229ed9"/><circle cx="9.5" cy="13.5" r="2.4" fill="#fff" opacity=".8"/><circle cx="22.5" cy="13.5" r="2.4" fill="#fff" opacity=".8"/><circle cx="16" cy="12" r="3.4" fill="#fff"/><path d="M9.5 23c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6z" fill="#fff"/></svg>`;
const SOCIAL_WAIT=8000, socialOpen={};   // Claim unlocks 8s after the person taps Join/Follow
const SOCIALS = [
  { id:'tggroup',   n:'Telegram group',         act:'Join',      url:officialGroupLink },
  { id:'support',   n:'Telegram support group', act:'Join',      url:supportLink },
  { id:'instagram', n:'Instagram',              act:'Follow',    url:'https://www.instagram.com/sutra_token_12?mdxt=N3R6N3BqeDZ1amE2' },
  { id:'facebook',  n:'Facebook',               act:'Follow',    url:'https://www.facebook.com/share/1CVB3s3qZm/' },
  { id:'twitter',   n:'Twitter / X',            act:'Follow',    url:'' },   // Coming soon: paste your Twitter/X link
  { id:'youtube',   n:'YouTube',                act:'Subscribe', url:'' },   // Coming soon: paste your YouTube channel link
  { id:'telegram',  n:'Telegram channel',       act:'Join',      url:'' }    // Coming soon: paste your Telegram channel link
];

const TOTAL_SUPPLY = 2e12, DAY = 864e5, BOOST_MS = 144e5, BASE = 2000/86400;
const BOOST_BONUS = {1:500, 2:500, 3:1000};
const BOOST_DAILY_LIMIT = 2;
const FUEL_MAX = 500;                                   // taps per day
const REF_FRIEND_REWARD = 500;   // paid instantly when an invited friend starts mining
const REF_LEVELS = 20, refNeed = n => 5*n, refReward = n => 300*n;   // 5,10,15… friends → 300,600,900… SUTRA
const boostRate = () => boostLevel ? BOOST_BONUS[boostLevel]/(BOOST_MS/1000) : 0;
const $ = id => document.getElementById(id);
const dayNum = () => Math.floor((Date.now()-new Date().getTimezoneOffset()*6e4)/864e5);
// ===== sound + haptic feedback (sounds are synthesized, no audio files needed) =====
const settings={sound:true,vibrate:true,strength:'medium',notify:true,mine:true};
let _ac;
function sfx(t){
  if(!settings.sound) return;
  try{
    _ac=_ac||new (window.AudioContext||window.webkitAudioContext)(); if(_ac.state==='suspended') _ac.resume();
    const N={tap:[[660,.04]],click:[[440,.03]],success:[[523,.09],[659,.09],[784,.14]],error:[[220,.14],[180,.14]],level:[[523,.1],[659,.1],[784,.1],[1047,.24]],notify:[[880,.08],[1175,.12]]}[t]||[];
    let at=_ac.currentTime;
    N.forEach(([f,d])=>{ const o=_ac.createOscillator(), g=_ac.createGain(); o.type=t==='error'?'sawtooth':'sine'; o.frequency.value=f;
      g.gain.setValueAtTime(.0001,at); g.gain.exponentialRampToValueAtTime(t==='tap'||t==='click'?.05:.12,at+.01); g.gain.exponentialRampToValueAtTime(.0001,at+d);
      o.connect(g); g.connect(_ac.destination); o.start(at); o.stop(at+d+.02); at+=d; });
  }catch(e){}
}
function haptic(kind='tick'){
  if(!settings.vibrate||settings.strength==='off') return;
  try{
    const h=window.Telegram?.WebApp?.HapticFeedback;
    if(kind!=='tick' && h?.notificationOccurred) return h.notificationOccurred(kind);
    if(kind==='tick' && h?.impactOccurred) return h.impactOccurred({light:'light',medium:'medium',strong:'heavy'}[settings.strength]);
    const ms={light:10,medium:25,strong:45}[settings.strength]; navigator.vibrate?.(kind==='tick'?ms:[ms,40,ms*2]);
  }catch(e){}
}

function showToast(msg, kind='info'){
  if(kind==='error'){ sfx('error'); haptic('error'); }
  const t=$('toastBox'); t.textContent=msg; t.className='toast show '+(kind==='error'?'err':'');
  clearTimeout(window._toastT); window._toastT=setTimeout(()=>t.classList.remove('show'),2600);
}
function showSuccess(title, msg){
  sfx('success'); haptic('success');
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
let claims=[], totalEarned=0;
let socialDone=[], tapDay=-1, fuel=FUEL_MAX, tapMult=1, refLevelPaid=0;
let refTotal=0, refSeen=0, notifs=[];
let badgesSeen=null, milestonePaid=[], refHist={}, ciDay=-1, ciStreak=0, chDay=-1, chProg={}, chDone=[], combo=0, lastTapT=0, dayHist={}, histFirst=-1, alertMark={s:0,soon:0,done:0}, refPaid=[], refQSent=false, refFriendEarn=0;
let globalMined=0, globalUsers=0, onlineUsers=0, tick=0;

const snapshot = () => ({balance, pending, miningStart, boostLevel, boostEnd, lastCalc, totalSessions, referralCount, adIndex, activity, referredBy, claimedSessions, dailyStreak, lastDailyDay, boostDay, boostUses, claims, totalEarned, socialDone, tapDay, fuel, tapMult, refLevelPaid, refSeen, notifs, settings, badgesSeen, milestonePaid, refHist, ciDay, ciStreak, chDay, chProg, chDone, dayHist, histFirst, alertMark, refPaid, refQSent, refFriendEarn});
async function saveNow(extra={}){ const u=getUserId(); if(!loaded||!u) return; await window.saveUserData(u,{...snapshot(),...extra}); pushLeaderboardRow(); }
function log(m){ activity.unshift({m, t:new Date().toLocaleString()}); activity.length=Math.min(activity.length,50); histEvent(m); renderActivity(); }
const CLAIM_LABEL={mining:"⛏️ Mining claimed",gift:"🎁 Daily gift claimed",video:"🎬 Video reward",social:"🔗 Social task",streak:"🔥 Streak bonus",checkin:"📅 Daily check-in",challenge:"🎯 Daily challenge",milestone:"🎯 Referral milestone",referral:"🤝 Referral level reward"};
function addClaim(type, amt){ totalEarned+=Number(amt)||0; if(type!=='mining') histAdd(dayNum(),'o',Number(amt)||0); claims.unshift({type, amt:Number(amt), t:Date.now()}); claims.length=Math.min(claims.length,100); renderClaims(); }
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
function authStep(st){ ['Create','Sent','Login','Forgot'].forEach(n=>$('st'+n).style.display = n.toLowerCase()===st?'block':'none'); }
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
// ===== forgot password: email → 2s check → one-time security code → reset link emailed =====
// The code is a fresh random 6-digit number each time and only confirms a person is on this screen (blocks scripts from
// spamming reset emails). Identity is proven by the reset link that goes to the email's real owner.
let fgEmail='', fgCode='', fgTries=0;
async function forgotSubmit(){
  const err=$('fErr'), b=$('fBtn'), email=$('fEmail').value.trim(); err.innerText='';
  if(!/^\S+@\S+\.\S+$/.test(email)){ err.innerText='Enter a valid email.'; return; }
  b.disabled=true; b.innerText='Please wait...';
  await new Promise(r=>setTimeout(r,2000));
  fgEmail=email; fgTries=0; fgCode=String(crypto.getRandomValues(new Uint32Array(1))[0]%900000+100000);
  $('codeShow').innerText=fgCode; $('codeIn').value=''; $('codeErr').innerText=''; $('codePop').style.display='flex';
  b.disabled=false; b.innerText='Submit';
}
function forgotCancel(){ fgCode=''; $('codePop').style.display='none'; }
async function forgotConfirm(){
  const v=$('codeIn').value.trim(), b=$('codeBtn');
  if(!fgCode){ forgotCancel(); return; }
  if(v!==fgCode){ if(++fgTries>=3){ forgotCancel(); $('fErr').innerText='Too many wrong attempts. Please submit again.'; return; } $('codeErr').innerText='Code does not match.'; return; }
  b.disabled=true;
  try{ await window.sendReset(fgEmail); }
  catch(e){
    if(e.code!=='auth/user-not-found'){ $('codeErr').innerText=e.code==='auth/too-many-requests'?'Too many requests. Try again later.':'Could not send the email. Please try again.'; b.disabled=false; return; }
  }
  b.disabled=false; forgotCancel(); authStep('login');
  showSuccess('Check your email','If this email is registered, a password reset link has been sent.');
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
    const inc=BASE*(secs-bs) + (BASE+boostRate())*bs; pending+=inc; histSplit(t0,t1,inc);
    if(balance+pending>TOTAL_SUPPLY) pending=Math.max(0,TOTAL_SUPPLY-balance);
  }
  lastCalc=now;
  if(boostLevel>0 && now>=boostEnd){ { const bm=`${["2x","3x","4x"][boostLevel-1]} boost ended`; settings.mine!==false?notify("🚀",bm):log("🚀 "+bm); } boostLevel=0; }
}
const mState = (now=Date.now()) => !miningStart ? 'idle' : now<miningStart+DAY ? 'mining' : 'done';
const fmt = ms => `${Math.floor(ms/36e5)}h ${Math.floor(ms%36e5/6e4)}m ${Math.floor(ms%6e4/1e3)}s`;
const RANKS=[[1e6,"👑 Legend Miner"],[5e5,"💎 Diamond Miner"],[1e5,"🥇 Gold Miner"],[5e4,"🥈 Silver Miner"],[1e4,"🥉 Bronze Miner"],[0,"🪨 New Miner"]];
const getRank = b => RANKS.find(r=>b>=r[0])[1];

function render(){
  const now=Date.now(), st=mState(now), total=balance+pending;
  renderTap(); renderRef(); renderRings(); renderRefStats(); renderCombo(); if($('s-earn').classList.contains('on')) renderChallenges();
  $('tokenBalance').innerText=total.toFixed(3); $('modalTokenBal').innerText=total.toFixed(3); $('sstLine').innerText='≈ '+(total/SST_RATE).toFixed(3)+' SST · 1,000 SUTRA = 1 SST'; $('sstWallet').innerText=(total/SST_RATE).toFixed(3)+' SST';
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
  btn.disabled = st==='mining' && fuel<=0;
  if(st==='mining'){
    const left=miningStart+DAY-now;
    $('mineIcon').innerText="⛏️"; $('mineText').innerText=fuel>0?`Tap · +${+tapGain().toFixed(1)}`:"No fuel"; $('mineSubText').innerText=fmt(left)+" left";
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
let _hd=dayNum();
function loop(){ settle(); checkMiningAlerts(); if(mState()==='mining' && !saverOn() && !document.hidden) minePulse(); if(_hd!==dayNum()){ _hd=dayNum(); saveNow(); } render(); }   // the timer and balance always update every second; battery saver only turns off animations and effects

async function dialAction(){ if(busy) return; busy=true; try{ await dialInner(); } finally{ busy=false; } }
async function dialInner(){
  if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
  if(!getUserId()){ showToast(window.linkError?'Could not connect — see Profile for details':'Please log in from the Profile tab first.','error'); switchTab('profile'); return; }
  const st=mState();
  if(st==='done'){
    try{ await playAd('claim'); }catch(e){ return; }
    if(mState()!=='done') return;
    settle(); const claimed=pending; balance+=pending; claimedSessions++; log(`✅ Claimed ${claimed.toFixed(3)} SUTRA`); addClaim('mining',claimed); pending=0; miningStart=0; boostLevel=0; boostEnd=0;
    await saveNow(); render(); showSuccess(`${claimed.toFixed(3)} SUTRA added to your balance`);
    return;
  }
  if(st!=='idle') return;
  if(globalMined>=TOTAL_SUPPLY){ showToast("Total supply has been fully mined.","error"); return; }
  try{ await playAd('start'); }catch(e){ return; }
  const ts=Date.now(); let r;
  try{ r=await window.tryStartSession(getUserId(), ts); }catch(e){ showToast("Could not start. Check your connection.","error"); return; }
  if(!r.ok){
    const d=r.data; miningStart=d.miningStart; pending=Math.max(pending,d.pending||0); lastCalc=d.lastCalc||miningStart; boostLevel=d.boostLevel||0; boostEnd=d.boostEnd||0;
    showToast("Mining is already running. Next session starts after 24 hours.","error"); render(); return;
  }
  miningStart=ts; lastCalc=ts; pending=0; boostLevel=0; boostEnd=0; totalSessions++; markReferralQualified();
  log("⛏️ 24-hour mining started"); await saveNow(); render();
}
async function handleBooster(n){ if(busy) return; busy=true; try{ await boosterInner(n); } finally{ busy=false; } }
async function boosterInner(n){
  if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
  if(!getUserId()){ showToast(window.linkError?'Could not connect — see Profile for details':'Please log in from the Profile tab first.','error'); switchTab('profile'); return; }
  if(mState()!=='mining' || boostLevel!==n-1) return;
  if(boostDay!==dayNum()){ boostDay=dayNum(); boostUses=0; }
  if(n===1 && boostUses>=BOOST_DAILY_LIMIT){ showToast(`You can use the booster only ${BOOST_DAILY_LIMIT} times a day. Try again tomorrow.`,'error'); return; }
  try{ await playAd('boost'); }catch(e){ return; }
  settle();
  if(mState()!=='mining' || boostLevel!==n-1) return;
  if(n===1){ boostEnd=Date.now()+BOOST_MS; boostUses++; }
  if(n===1) chAdd('boost',1); boostLevel=n; log(`🚀 ${['2x','3x','4x'][n-1]} boost activated (+${BOOST_BONUS[n]} SUTRA / 4h)`); await saveNow(); render();
}

// ===== tap & earn: 500 fuel per day, 1 fuel per tap, 1x → 2x after a video =====
function tapRoll(){ if(tapDay!==dayNum()){ tapDay=dayNum(); fuel=FUEL_MAX; tapMult=1; } }
function renderTap(){
  tapRoll(); if(!$('fuelTxt')) return;
  $('fuelTxt').innerText=`${fuel} / ${FUEL_MAX}`; $('fuelBar').style.width=(fuel/FUEL_MAX*100)+'%';
  $('mineBtn').classList.toggle('x2',tapMult===2&&mState()==='mining');
  const t=$('tapBoostBtn'); t.disabled=tapMult===2||fuel<=0; t.innerText=tapMult===2?'⚡ 2x ON':'⚡ Fuel 2x';
}
let tapSaveT;
function doTap(e){ if(mState()!=='mining') return; { const s=$('mineIcon'); s.classList.remove('swing'); void s.offsetWidth; s.classList.add('swing'); }
  if(!loaded||!getUserId()) return; tapRoll();
  if(fuel<=0){ showToast('Fuel is empty. It refills tomorrow.','error'); return; }
  const nowT=Date.now(); combo=(nowT-lastTapT<700)?combo+1:1; lastTapT=nowT; const cm=comboMult(), gain=tapGain();
  fuel--; balance+=gain; totalEarned+=gain; histAdd(dayNum(),'o',gain); chSet('combo',combo); chAdd('taps',1);
  const p=document.createElement('div'); p.className='pop'+(tapMult===2||cm>1?' x2':''); p.textContent='+'+gain+(cm>1&&tapMult===1?' ×'+cm:'');
  p.style.left=(e.clientX-10)+'px'; p.style.top=(e.clientY-30)+'px'; document.body.appendChild(p); setTimeout(()=>p.remove(),750);
  sfx('tap'); haptic('tick');
  render(); clearTimeout(tapSaveT); tapSaveT=setTimeout(()=>saveNow(),2500);
}
async function tapBoost(){
  if(busy) return; busy=true;
  try{
    if(!loaded||!getUserId()) return; tapRoll(); if(tapMult===2||fuel<=0) return;
    try{ await playAd('fuel'); }catch(e){ return; }
    tapMult=2; await saveNow(); render(); showSuccess('2x activated','Each tap now gives 2 SUTRA until your fuel runs out');
  } finally{ busy=false; }
}
$('mineBtn').addEventListener('pointerdown',doTap);

const SST_RATE=1000;   // 1,000 SUTRA = 1 SST coin
const streakLive=()=>lastDailyDay>=dayNum()-1?dailyStreak:0;
function setRing(id,pct,txt){ const e=$('rg'+id); if(!e) return; e.style.strokeDasharray=`${Math.max(0,Math.min(100,pct))} 100`; $('rg'+id+'T').innerText=txt; }
function renderRings(){ setRing('Fuel',fuel/FUEL_MAX*100,fuel); setRing('Streak',streakLive()/30*100,streakLive()+'d'); setRing('Ref',refLevel()/REF_LEVELS*100,refLevel()+'/'+REF_LEVELS); }
function renderRefStats(){
  if(!$('rsTotal')) return; const L=refLevelPaid, tot=Math.max(refTotal,referralCount);
  $('rsTotal').innerText=tot; $('rsQual').innerText=referralCount; $('rsWait').innerText=refWaiting;
  $('rsConv').innerText=(tot?Math.round(referralCount/tot*100):0)+'%'; $('rsEarn').innerText=(300*L*(L+1)/2+refFriendEarn).toLocaleString()+' SUTRA';
}
function notify(icon,msg,big){
  notifs.unshift({i:icon,m:msg,t:Date.now()}); notifs.length=Math.min(notifs.length,30); renderNotifs(); log(icon+' '+msg);
  if(!settings.notify) return;
  showToast(icon+' '+msg); sfx(big?'level':'notify'); haptic('success');
}
function renderNotifs(){ const e=$('notifList'); if(e) e.innerHTML=notifs.map(n=>`<div class="item ntf"><b>${esc(n.i)} ${esc(n.m)}</b>${esc(new Date(n.t).toLocaleString())}</div>`).join("")||'<div class="item">No notifications yet.</div>'; }
function applySettingsUI(){ $('setSound').checked=settings.sound; $('setVib').checked=settings.vibrate; $('setNotif').checked=settings.notify; $('setStr').value=settings.strength; $('setMine').checked=settings.mine!==false; $('setSaver').value=settings.saver||'auto'; }
function saveSettings(){ settings.sound=$('setSound').checked; settings.vibrate=$('setVib').checked; settings.notify=$('setNotif').checked; settings.strength=$('setStr').value; settings.mine=$('setMine').checked; settings.saver=$('setSaver').value; applySaver(); sfx('click'); haptic('tick'); saveNow(); }
// ===== battery saver: auto-enables below 20% battery (or force on/off in Settings) =====
let batteryLow=false;
const saverOn=()=>settings.saver==='on'||(settings.saver!=='off'&&batteryLow);
function applySaver(){ document.body.classList.toggle('saver',saverOn()); }
try{ navigator.getBattery?.().then(b=>{ const u=()=>{ batteryLow=b.level<=.2&&!b.charging; applySaver(); }; u(); b.addEventListener('levelchange',u); b.addEventListener('chargingchange',u); }); }catch(e){}

// ===== tap combo: tap faster than 0.7s apart to build a combo =====
const comboMult=()=>combo>=40?2:combo>=15?1.5:1;
const tapGain=()=>Math.min(2,tapMult*comboMult());   // total tap multiplier never goes above 2x
function renderCombo(){
  const e=$('comboBox'); if(!e) return; if(combo>0&&Date.now()-lastTapT>700) combo=0;
  const m=tapGain(); e.className='combo'+(m>=2?' hot3':m>1?' hot1':'');
  e.innerText=tapMult===2?'⚡ Fuel 2x active · maximum 2x':combo>1?`🔥 Combo ${combo} · ×${comboMult()}`+(combo>=40?' · MAX 2x':` · next ×${combo>=15?2:1.5} at ${combo>=15?40:15}`):'Tap fast for a combo: 15 → ×1.5 · 40 → ×2 (max)';
}

// ===== referral badges (animated unlock), milestones, progress chart =====
const BADGES=[{id:'b1',i:'🥉',n:'Starter',need:1},{id:'b5',i:'🥈',n:'Connector',need:5},{id:'b15',i:'🥇',n:'Influencer',need:15},{id:'b30',i:'💎',n:'Ambassador',need:30},{id:'b60',i:'👑',n:'Champion',need:60},{id:'b100',i:'🚀',n:'Legend',need:100}];
function renderBadges(newId){
  const e=$('badgeGrid'); if(!e) return;
  e.innerHTML=BADGES.map(b=>{ const on=referralCount>=b.need; return `<div class="bdg ${on?'on':''} ${b.id===newId?'new':''}"><span>${b.i}</span><b>${b.n}</b><small>${on?'Unlocked':b.need+' friends'}</small></div>`; }).join("");
}
function badgePopup(b){
  const d=document.createElement('div'); d.className='bpop'; d.innerHTML=`<div class="bbox"><div class="bico">${b.i}</div><b>Badge unlocked!</b><span>${esc(b.n)}</span></div>`;
  d.onclick=()=>d.remove(); document.body.appendChild(d); setTimeout(()=>d.remove(),3200);
}
function checkBadges(){
  const earned=BADGES.filter(b=>referralCount>=b.need).map(b=>b.id);
  if(!Array.isArray(badgesSeen)){ badgesSeen=earned; renderBadges(); return true; }   // first run after update: unlock silently
  const fresh=earned.filter(id=>!badgesSeen.includes(id)); if(!fresh.length){ renderBadges(); return false; }
  badgesSeen=badgesSeen.concat(fresh); const b=BADGES.find(x=>x.id===fresh[fresh.length-1]);
  renderBadges(b.id); badgePopup(b); notify(b.i,`Badge unlocked: ${b.n}`,true); return true;
}
const MILESTONES=[{need:10,r:500},{need:25,r:1500},{need:50,r:3000},{need:100,r:3000}];
function payMilestones(){
  let p=false;
  MILESTONES.forEach(m=>{ if(referralCount>=m.need && !milestonePaid.includes(m.need)){
    milestonePaid.push(m.need); balance+=m.r; addClaim('milestone',m.r); notify('🎯',`Milestone reached: ${m.need} friends! +${m.r.toLocaleString()} SUTRA`,true); p=true; } });
  return p;
}
function renderMilestones(){
  const e=$('msList'); if(!e) return;
  e.innerHTML=MILESTONES.map(m=>{ const done=milestonePaid.includes(m.need), pct=Math.min(100,referralCount/m.need*100);
    return `<div class="ms"><div class="row" style="padding:2px 0"><span>${done?'✅':'🎯'} ${m.need} friends</span><b>+${m.r.toLocaleString()} SUTRA</b></div><div class="bar"><i style="width:${pct}%"></i></div><small>${done?'Completed':`${Math.min(referralCount,m.need)} / ${m.need} · ${m.need-referralCount} to go`}</small></div>`; }).join("");
}
function recordRefHist(){
  const t=dayNum(); if(!Object.keys(refHist).length) refHist[t-1]=referralCount;   // baseline so history starts flat
  refHist[t]=referralCount; const ks=Object.keys(refHist).map(Number).sort((a,b)=>a-b); while(ks.length>30) delete refHist[ks.shift()];
}
function renderRefChart(){
  const e=$('refChart'); if(!e) return; const t=dayNum(), ks=Object.keys(refHist).map(Number).sort((a,b)=>a-b);
  const cum=d=>{ let v=0; for(const k of ks){ if(k<=d) v=refHist[k]; } return v; };
  const days=[]; for(let i=13;i>=0;i--) days.push(t-i);
  const vals=days.map(d=>Math.max(0,cum(d)-cum(d-1))), mx=Math.max(1,...vals), sum=vals.reduce((a,b)=>a+b,0);
  const bars=vals.map((v,i)=>{ const h=Math.round(v/mx*52), x=i*20+4;
    return `<rect x="${x}" y="${64-h}" width="12" height="${v?h:2}" rx="3" fill="${v?'url(#cg)':'#3a2a1e'}"/>`+(v?`<text x="${x+6}" y="${60-h}" text-anchor="middle" font-size="8" fill="#fbf3ea">${v}</text>`:'')+`<text x="${x+6}" y="78" text-anchor="middle" font-size="7" fill="#b8a690">${new Date(days[i]*864e5).getUTCDate()}</text>`; }).join("");
  e.innerHTML=`<svg viewBox="0 0 284 84" width="100%"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb020"/><stop offset="1" stop-color="#ff7a1a"/></linearGradient></defs>${bars}</svg><div class="meterCap">+${sum} qualified friend${sum===1?'':'s'} in 14 days · ${referralCount} total</div>`;
}

// ===== daily check-in (7-day cycle, one tap, no video) =====
const CHECKIN=[20,30,40,50,70,100,200];
function renderCheckin(){
  const e=$('ciBox'); if(!e) return; const t=dayNum(), done=ciDay===t, live=ciDay>=t-1?ciStreak:0, cyc=done?((ciStreak-1)%7)+1:(live%7);
  e.innerHTML=`<div class="gift" style="grid-template-columns:repeat(7,1fr)">`+CHECKIN.map((r,i)=>`<div class="gd ${i<cyc?'done':''} ${!done&&i===cyc?'now':''}">D${i+1}<b>${r}</b></div>`).join("")+`</div><button class="btn" onclick="claimCheckin()" ${done?'disabled':''}>${done?'Checked in today ✓':`Watch video &amp; check in · +${CHECKIN[cyc]}`}</button>`;
}
async function claimCheckin(){
  if(busy) return; busy=true;
  try{
    if(!loaded||!getUserId()||ciDay===dayNum()) return;
    try{ await playAd('checkin'); }catch(e){ return; }
    const t=dayNum(); if(ciDay===t) return;
    ciStreak=(ciDay===t-1)?ciStreak+1:1; ciDay=t; const r=CHECKIN[(ciStreak-1)%7];
    balance+=r; addClaim('checkin',r); chAdd('checkin',1); log(`📅 Check-in day ${ciStreak}: +${r} SUTRA`);
    renderCheckin(); renderChallenges(); render(); saveNow(); showSuccess('Checked in!',`+${r} SUTRA · ${ciStreak}-day streak`);
  } finally{ busy=false; }
}

// ===== daily challenges: 3 per day, rotating =====
const CH_POOL=[{k:'taps',t:'Tap 100 times',g:100,r:150},{k:'combo',t:'Reach a 15-tap combo',g:15,r:100},{k:'checkin',t:'Do the daily check-in',g:1,r:50},{k:'boost',t:'Start a booster',g:1,r:150},{k:'gift',t:'Claim the daily gift',g:1,r:100},{k:'taps',t:'Tap 300 times',g:300,r:300}];
const chToday=()=>{ const s=dayNum()%6; return [s,(s+2)%6,(s+4)%6]; };
function chRoll(){ if(chDay!==dayNum()){ chDay=dayNum(); chProg={}; chDone=[]; } }
function chAdd(k,n){ if(!loaded) return; chRoll(); chProg[k]=(chProg[k]||0)+n; }
function chSet(k,v){ if(!loaded) return; chRoll(); chProg[k]=Math.max(chProg[k]||0,v); }
function renderChallenges(){
  const e=$('chList'); if(!e) return; chRoll();
  const h=chToday().map(i=>{ const c=CH_POOL[i], p=Math.min(c.g,chProg[c.k]||0), done=chDone.includes(i), ready=p>=c.g&&!done;
    return `<div class="ms"><div class="row" style="padding:2px 0"><span>${done?'✅':'🎯'} ${c.t}</span><b>+${c.r}</b></div><div class="bar"><i style="width:${p/c.g*100}%"></i></div><div class="vrow" style="border:0;padding:4px 0"><small>${p} / ${c.g}</small>${done?'<em class="ok">Claimed</em>':ready?`<button class="vbtn" onclick="claimChallenge(${i})">Watch &amp; claim</button>`:''}</div></div>`; }).join("");
  if(e.dataset.h!==h){ e.dataset.h=h; e.innerHTML=h; }
}
async function claimChallenge(i){
  if(busy) return; busy=true;
  try{
    chRoll(); const c=CH_POOL[i]; if(!c||!chToday().includes(i)||chDone.includes(i)||(chProg[c.k]||0)<c.g) return;
    try{ await playAd('challenge'); }catch(e){ return; }
    chRoll(); if(chDone.includes(i)) return;
    chDone.push(i); balance+=c.r; addClaim('challenge',c.r); log(`🎯 Challenge done: ${c.t} (+${c.r})`);
    renderChallenges(); render(); saveNow(); showSuccess('Challenge complete',`+${c.r} SUTRA`);
  } finally{ busy=false; }
}

// ===== day-by-day history: saved automatically, every day =====
const tzMs=()=>new Date().getTimezoneOffset()*6e4, dayStartMs=d=>d*864e5+tzMs();
function histAdd(d,k,v){
  if(!(v>0)) return; const e=dayHist[d]||(dayHist[d]={m:0,o:0}); e[k]+=v; if(histFirst<0) histFirst=d;
  const ks=Object.keys(dayHist).map(Number).sort((a,b)=>a-b); while(ks.length>60) delete dayHist[ks.shift()];
}
function histEvent(m){
  const d=dayNum(), e=dayHist[d]||(dayHist[d]={m:0,o:0}); if(histFirst<0) histFirst=d;
  (e.ev=e.ev||[]).push({t:Date.now(),m:String(m).slice(0,90)}); if(e.ev.length>25) e.ev.shift();
  Object.keys(dayHist).forEach(k=>{ if(Number(k)<d-14&&dayHist[k].ev) delete dayHist[k].ev; });
}
function histSplit(t0,t1,inc){      // mining earned across midnight is split between the two days
  const tot=t1-t0; if(tot<=0) return;
  for(let d=Math.floor((t0-tzMs())/864e5), end=Math.floor((t1-tzMs())/864e5); d<=end; d++){
    const ov=Math.min(t1,dayStartMs(d+1))-Math.max(t0,dayStartMs(d)); if(ov>0) histAdd(d,'m',inc*ov/tot); }
}
function renderDayHist(){
  const el=$('dayHist'); if(!el) return; const ks=Object.keys(dayHist).map(Number).sort((a,b)=>b-a), t=dayNum();
  if(!ks.length){ el.innerHTML='<div class="item">Your daily history will appear here.</div>'; return; }
  const f=n=>n.toLocaleString(undefined,{minimumFractionDigits:3,maximumFractionDigits:3});
  el.innerHTML=ks.map(d=>{ const e=dayHist[d], dt=new Date(dayStartMs(d)).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
    const ev=(e.ev||[]).slice().reverse().map(x=>`<div style="padding:3px 0 3px 10px;border-left:2px solid var(--line);margin-top:4px">${esc(new Date(x.t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))} · ${esc(x.m)}</div>`).join("");
    return `<div class="item"><div class="row" style="padding:0"><b style="font-size:13px">Day ${d-histFirst+1}${d===t?' · Today (live)':''}</b><b class="ok" style="font-size:14px">+${f((e.m||0)+(e.o||0))}</b></div>${esc(dt)} · ⛏️ ${f(e.m||0)} mining · 🎁 ${f(e.o||0)} rewards &amp; taps${ev}</div>`; }).join("");
}
function openHistory(){ renderDayHist(); renderActivity(); openSheet('actModal'); }

// ===== mining animation + session alerts =====
function minePulse(){      // shows the real per-second mining rate rising from the dial
  const h=$('hero'); if(!h) return; const s=document.createElement('span'); s.className='float';
  s.textContent='+'+(BASE+(boostLevel>0&&Date.now()<boostEnd?boostRate():0)).toFixed(3);
  s.style.left=(28+Math.random()*44)+'%'; s.style.top=(30+Math.random()*20)+'%'; h.appendChild(s); setTimeout(()=>s.remove(),1000);
}
function checkMiningAlerts(){
  if(!loaded||settings.mine===false||!miningStart) return;
  const left=miningStart+DAY-Date.now();
  if(alertMark.s!==miningStart) alertMark={s:miningStart,soon:0,done:0};
  if(left<=0 && !alertMark.done){ alertMark.done=1; notify('✅','Your 24-hour mining session is complete. Tap Claim to collect your SUTRA.',true); saveNow(); }
  else if(left>0 && left<=36e5 && !alertMark.soon){ alertMark.soon=1; notify('⏳','Your mining session ends in less than 1 hour.'); }
}

// ===== weekly mining report (last 7 days vs the 7 before) =====
function openWeekly(){ renderWeekly(); openSheet('wkModal'); }
function renderWeekly(){
  const t=dayNum(), f=n=>Math.round(n).toLocaleString(), g=d=>{ const e=dayHist[d]; return e?e.m+e.o:0; };
  const days=[]; for(let i=6;i>=0;i--) days.push(t-i);
  const vals=days.map(g), tot=vals.reduce((a,b)=>a+b,0), mining=days.reduce((a,d)=>a+(dayHist[d]?dayHist[d].m:0),0);
  let prev=0; for(let i=7;i<=13;i++) prev+=g(t-i);
  const best=Math.max(...vals), bi=vals.indexOf(best), active=vals.filter(v=>v>0).length, mx=Math.max(1,...vals), chg=prev>0?Math.round((tot-prev)/prev*100):null;
  const wd=(d,o)=>new Date(dayStartMs(d)).toLocaleDateString(undefined,{weekday:o});
  const bars=vals.map((v,i)=>{ const h=Math.round(v/mx*66), x=i*40+8;
    return `<rect x="${x}" y="${80-h}" width="24" height="${v?h:2}" rx="5" fill="${v?'url(#wg)':'#3a2a1e'}"/>`+(v?`<text x="${x+12}" y="${76-h}" text-anchor="middle" font-size="9" fill="#fbf3ea">${f(v)}</text>`:'')+`<text x="${x+12}" y="94" text-anchor="middle" font-size="9" fill="#b8a690">${wd(days[i],'short')}</text>`; }).join("");
  $('wkBody').innerHTML=`<svg viewBox="0 0 290 100" width="100%"><defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ee6a6"/><stop offset="1" stop-color="#ffb020"/></linearGradient></defs>${bars}</svg>`
   +`<div class="row"><span>Total this week</span><b class="ok">+${f(tot)} SUTRA</b></div><div class="row"><span>⛏️ From mining</span><b>${f(mining)}</b></div><div class="row"><span>🎁 Rewards &amp; taps</span><b>${f(tot-mining)}</b></div>`
   +`<div class="row"><span>Daily average</span><b>${f(tot/7)}</b></div><div class="row"><span>Active days</span><b>${active} / 7</b></div>`
   +`<div class="row"><span>Best day</span><b>${best>0?wd(days[bi],'long')+' · '+f(best):'—'}</b></div>`
   +`<div class="row"><span>vs previous 7 days</span><b class="${chg===null?'':chg>=0?'ok':'bad'}">${chg===null?'No earlier data yet':(chg>=0?'+':'')+chg+'%'}</b></div>`;
}

async function loadRefBoard(){
  try{ const top=(await window.lbTopRef()).filter(x=>(x.refs||0)>0);
    $('refBoard').innerHTML=top.map((x,i)=>`<div class="lb"><div>${['🥇','🥈','🥉'][i]||'#'+(i+1)} ${esc(x.name||"Miner")}<small>${esc(x.rank||"")}</small></div><b class="s">${x.refs} 👥</b></div>`).join("")||"No referrals yet — be the first!";
  }catch(e){ $('refBoard').innerText="Leaderboard unavailable"; }
}
document.addEventListener('click',e=>{ if(e.target.closest('.btn,.tab,.bst,.vbtn,.core')){ haptic('tick'); sfx('click'); } });

// ===== video ads =====
function playAd(place){
  return new Promise((resolve,reject)=>{
    const i=adIndex%AD_SEQUENCE.length, secs=AD_SEQUENCE[i], url=(place&&AD_SLOTS[place])||AD_VIDEOS[i];
    const box=$('adBox'), v=$('adVideo'); let left=secs, done=false;
    v.style.display=url?'block':'none'; $('adPh').style.display=url?'none':'block';
    if(url){ v.src=url; v.play().catch(()=>{}); }
    box.style.display='flex';
    $('adClose').innerText="Cancel"; $('adBar').style.width="0";
    const finish=(ok)=>{ clearInterval(t); v.pause(); v.removeAttribute('src'); box.style.display='none'; $('adClose').onclick=null; if(ok){ adIndex++; resolve(); } else reject(); };
    const paint=()=>{ $('adText').innerText=`Reward in ${left}s`; $('adBar').style.width=((secs-left)/secs*100)+'%'; };
    paint();
    const t=setInterval(()=>{ if(document.hidden) return; left--; paint(); if(left<=0){ done=true; $('adText').innerText="Done"; $('adClose').innerText="Get reward"; clearInterval(t); } },1000);
    $('adClose').onclick=()=>finish(done);
  });
}

// ===== rewards: daily gift, social claims =====
function nextGiftDay(){ const t=dayNum(); if(lastDailyDay===t) return 0; let n=(lastDailyDay===t-1)?dailyStreak+1:1; return n>30?1:n; }
function renderGift(){ renderCheckin(); renderChallenges();
  const t=dayNum(), live=lastDailyDay>=t-1?dailyStreak:0, nx=nextGiftDay(); let h="";
  for(let n=1;n<=30;n++) h+=`<div class="gd ${n<=live&&!(nx===1&&live===30)?'done':''} ${n===nx?'now':''}">Day ${n}<b>${n*50}</b></div>`;
  $('giftGrid').innerHTML=h; const b=$('giftBtn');
  b.disabled=!nx; b.innerText = nx ? `Watch video & claim ${nx*50} SUTRA` : "Claimed today. Come back tomorrow";
}
async function claimDailyReward(){ if(busy) return; busy=true; try{ await giftInner(); } finally{ busy=false; } }
async function giftInner(){
  if(!loaded && getUserId() && !window.linkError){ showToast('Loading… please wait'); return; }
  if(!getUserId()){ showToast(window.linkError?'Could not connect — see Profile for details':'Please log in from the Profile tab first.','error'); switchTab('profile'); return; }
  const day=nextGiftDay(); if(!day){ showToast("Already claimed today. Come back tomorrow."); return; }
  const streakBroken = day===1 && dailyStreak>1;
  try{ await playAd('gift'); }catch(e){ return; }
  if(!nextGiftDay()) return;
  if(streakBroken) log(`⏳ Daily gift streak expired after Day ${dailyStreak} — restarting from Day 1`);
  balance+=day*50; dailyStreak=day; lastDailyDay=dayNum(); log(`🎁 Day ${day} gift claimed (${day*50} SUTRA)`); addClaim('gift',day*50); chAdd('gift',1);
  await saveNow(); renderGift(); render(); showSuccess(`Day ${day} gift claimed: ${(day*50).toLocaleString()} SUTRA`);
}
function renderSocials(){
  const now=Date.now(), h=SOCIALS.map(s=>{
    const head=`<div class="vrow"><span class="sl"><span class="sic">${IC[s.id]}</span>${s.n}</span>`, o=socialOpen[s.id];
    if(socialDone.includes(s.id)) return head+`<em class="ok">✓ Claimed</em></div>`;
    if(!s.url) return head+`<span class="soonpill">Coming soon</span></div>`;
    if(!o) return head+`<button class="vbtn" onclick="openSocial('${s.id}')">${s.act}</button></div>`;
    if(!socialReady(s.id)) return head+`<button class="vbtn" disabled>Checking…</button></div>`;
    return head+`<button class="vbtn" onclick="claimSocial('${s.id}')">Watch &amp; claim +${SOCIAL_REWARD}</button></div>`;
  }).join("");
  ['vidList','socialList'].forEach(i=>{ if($(i)) $(i).innerHTML=h; });
}
// Claim unlocks when the person comes back to the app after opening the link (min 4s), or after 8s at the latest
const socialBack={};
function socialReady(id){ const o=socialOpen[id]; if(!o) return false; const e=Date.now()-o; return e>=SOCIAL_WAIT||(!!socialBack[id]&&e>=4000); }
document.addEventListener('visibilitychange',()=>{ if(document.hidden) return; Object.keys(socialOpen).forEach(id=>{ if(!socialBack[id]) socialBack[id]=Date.now(); }); renderSocials(); });
function openSocial(id){
  const s=SOCIALS.find(x=>x.id===id); if(!s||!s.url||socialDone.includes(id)) return;
  if(tg?.openTelegramLink && /t\.me/.test(s.url)) tg.openTelegramLink(s.url); else if(tg?.openLink) tg.openLink(s.url); else window.open(s.url,'_blank');
  socialOpen[id]=Date.now(); delete socialBack[id]; renderSocials(); setTimeout(renderSocials,4150); setTimeout(renderSocials,SOCIAL_WAIT+150);
}
async function claimSocial(id){
  if(busy) return; busy=true;
  try{
    if(!loaded){ showToast('Loading… please wait'); return; }
    const s=SOCIALS.find(x=>x.id===id); if(!s||!s.url||socialDone.includes(id)) return;
    if(!socialReady(id)){ showToast(`Please ${s.act.toLowerCase()} first, then claim.`,'error'); return; }
    const uid=getUserId();
    try{ if(await window.socialClaimed(uid,id)){ if(!socialDone.includes(id)) socialDone.push(id); await saveNow(); renderSocials(); showToast('This reward was already claimed.','error'); return; } }catch(e){ showToast('Could not check your claim. Check your connection.','error'); return; }
    try{ await playAd('social'); }catch(e){ return; }
    if(socialDone.includes(id)) return;
    try{ await window.socialClaim(uid,id); }
    catch(e){ if(e.code==='permission-denied'){ if(!socialDone.includes(id)) socialDone.push(id); await saveNow(); renderSocials(); showToast('This reward was already claimed.','error'); } else showToast('Could not claim. Check your connection.','error'); return; }
    balance+=SOCIAL_REWARD; socialDone.push(id); log(`🔗 Joined ${s.n} · +${SOCIAL_REWARD} SUTRA`); addClaim('social',SOCIAL_REWARD);
    await saveNow(); renderSocials(); render(); showSuccess(`${SOCIAL_REWARD} SUTRA added`);
  } finally{ busy=false; }
}

async function pushLeaderboardRow(){
  if(!getUserId()) return;
  const total=balance+pending;
  try{ await window.saveLeaderboardRow(getUserId(), {
    name: (profile.name||"Miner").substring(0,3)+"***", balance: total, refs: referralCount, rank: getRank(total),
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

const PLAY_STORE_LINK = "";
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); showToast("Copied to clipboard"); return; }catch(e){}
  $('shareTextBox').value=t; openSheet('shareModal');
}
function setupShare(){
  const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${getUserId()}`;
  const msg=`🚀 Mine $SUTRA free! Join with my link and start earning.`;
  const text=`${msg}\n${refLink}`+(PLAY_STORE_LINK?`\n\nGet the app: ${PLAY_STORE_LINK}`:"");
  window.shareApp=async()=>{
    if(navigator.share){ try{ await navigator.share({title:'Sutra Token Mining',text}); return; }catch(e){ if(e.name==='AbortError') return; } }
    if(tg?.openTelegramLink){ tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(msg)}`); return; }
    copyText(text);
  };
  window.copyRef=()=>copyText(text);
}

// ===== referral levels: 20 levels, every 5 friends = next level, reward 300 × level =====
const refLevel = () => Math.min(REF_LEVELS, Math.floor(referralCount/5));
function payRefLevels(){
  let paid=false;
  while(refLevelPaid<refLevel()){
    const n=++refLevelPaid; balance+=refReward(n); addClaim('referral',refReward(n));
    notify('🏆',`Referral Level ${n} reached! +${refReward(n)} SUTRA`,true); paid=true;
  }
  return paid;
}
let refList=[], refLvlSeen=-1;
function renderRef(){
  if(!$('refLvl')) return; const l=refLevel(), ready=refLevelPaid<l, nxt=Math.min(refLevelPaid+1,REF_LEVELS), full=refLevelPaid>=REF_LEVELS;
  $('refLvl').innerText=`${l} / ${REF_LEVELS}`;
  $('refLvlBar').style.width=((ready||full)?100:Math.max(0,Math.min(100,(referralCount-5*(nxt-1))/5*100)))+'%';
  $('refLvlTxt').innerText=full?'Max level reached 🎉':ready?`✅ Level ${nxt} reached · claim +${refReward(nxt).toLocaleString()} SUTRA`:`${referralCount} friends · ${refNeed(nxt)-referralCount} more for Level ${nxt} (+${refReward(nxt).toLocaleString()} SUTRA)`;
  const b=$('refClaimBtn'); b.style.display=ready?'block':'none'; b.innerText=`🎁 Watch video & claim Level ${nxt} · +${refReward(nxt).toLocaleString()} SUTRA`;
  $('refEarnTotal').innerText=(300*refLevelPaid*(refLevelPaid+1)/2+refFriendEarn).toLocaleString()+' SUTRA';
}
function renderRefList(){
  const el=$('refJoinList'); if(!el) return;
  if(!refList.length){ el.innerHTML='<div class="item">No friends have joined with your link yet. Share your link to get started.</div>'; return; }
  const mask=id=>id.length>5?id.slice(0,3)+'•••'+id.slice(-2):id.slice(0,2)+'•••';
  el.innerHTML=refList.map(r=>{ const t=r.createdAt&&r.createdAt.toDate?r.createdAt.toDate():null, d=t?t.toLocaleDateString(undefined,{day:'numeric',month:'short'}):'';
    const st=r.qualified?'<em class="ok">✅ Mining</em>':'<em>⏳ Joined · not mining yet</em>';
    return `<div class="vrow"><span>👤 ${esc(mask(String(r.id)))}${d?' · '+esc(d):''}</span>${st}</div>`; }).join("");
}
function readyLevelNotice(){ const l=refLevel(); if(refLvlSeen<0) refLvlSeen=refLevelPaid; if(l>refLvlSeen&&l>refLevelPaid){ refLvlSeen=l; notify('🏆',`Referral Level ${l} is ready to claim!`,true); } }
async function claimRefLevel(){
  if(busy) return; busy=true;
  try{
    if(!loaded||refLevelPaid>=refLevel()) return;
    try{ await playAd('referral'); }catch(e){ return; }
    if(refLevelPaid>=refLevel()) return;
    const n=++refLevelPaid, amt=refReward(n); balance+=amt; addClaim('referral',amt); log(`🏆 Referral level ${n} claimed: +${amt} SUTRA`);
    await saveNow(); renderRef(); render(); showSuccess(`Level ${n} reward claimed`,`+${amt.toLocaleString()} SUTRA`);
  } finally{ busy=false; }
}
async function markReferralQualified(){
  if(!referredBy||refQSent||!loaded) return;
  try{ await window.refEnsure(getUserId(),referredBy); await window.refMarkQualified(getUserId()); refQSent=true; saveNow(); }catch(e){ console.error('referral qualify failed',e); }
}
async function checkReferrals(){
  if(!loaded) return;
  try{
    const list=await window.refListFor(getUserId()); let wait=0, changed=false; refTotal=list.length;
    const nj=list.length-refSeen; if(nj>0){ notify('🎉',`${nj} new friend${nj>1?'s':''} joined with your link`); refSeen=list.length; changed=true; }
    for(const r of list){
      if(!r.qualified) { wait++; continue; }
      if(refPaid.includes(r.id)) continue;
      if(await window.refClaimed(r.id)){ refPaid.push(r.id); changed=true; continue; }
      try{
        await window.refClaim(r.id, getUserId());
        refPaid.push(r.id); referralCount++; refFriendEarn+=REF_FRIEND_REWARD; balance+=REF_FRIEND_REWARD; addClaim('referral',REF_FRIEND_REWARD); changed=true; notify('🤝',`A friend started mining · +${REF_FRIEND_REWARD} SUTRA · ${referralCount} friends`,true);
      }catch(e){}
    }
    refWaiting=wait; refList=list.slice().sort((a,b)=>((b.createdAt&&b.createdAt.seconds)||0)-((a.createdAt&&a.createdAt.seconds)||0)); readyLevelNotice(); renderRefList(); if(payMilestones()) changed=true; if(checkBadges()) changed=true; recordRefHist(); renderMilestones(); renderRefChart(); if(changed) await saveNow(); render();
  }catch(e){}
}
function openSupport(){ tg?.openTelegramLink ? tg.openTelegramLink(supportLink) : window.open(supportLink,"_blank"); }

// ===== boot =====
function bootFail(detail){
  const sc=$('secCheck'); if(sc) sc.remove();
  const b=$('mineBtn'); if(!b) return;
  $('mineIcon').innerText="⚠️"; $('mineText').innerText="Not connected"; $('mineSubText').innerText="Tap to retry";
  b.disabled=false; b.onclick=()=>location.reload();
  const d=String(detail||"unknown");
  console.error('Startup error:',d); const hint="Please check your internet connection and try again. If the problem continues, contact support.";
  const c=$('connErr'); if(c){ c.style.display='block'; c.innerHTML=`<h3 style="color:var(--lotus)">⚠️ Could not connect</h3><p>${esc(hint)}</p>`; }
}
window.bootApp = async function(au){
  authUser=au; const uid=getUserId();
  if(window.linkError){
    $('accountCard').innerHTML = `<h3 style="color:var(--lotus)">⚠️ Could not connect</h3>
      <p>${esc(window.linkError)}</p>
      <p>Please check your internet connection and try again.</p>
      <button class="btn alt" onclick="location.reload()">Retry</button>`;
    showToast('Could not connect — see Profile for details','error'); bootFail(window.linkError); return;
  }
  if(!uid){ showAuth('login',false); return; }
  let d=null;
  try{ const pre = window.__pre ? await window.__pre : { ok:false }; d = pre.ok ? pre.d : await window.loadUserData(uid); }catch(e){ showToast("Could not load your data. Check your connection and reopen the app.","error"); bootFail("Data load failed: "+(e.code||e.message)); return; }
  d=d||{}; profile=d;
  balance=Math.max(0,d.balance||0); pending=Math.max(0,d.pending||0); miningStart=d.miningStart||0;
  boostLevel=d.boostLevel||0; boostEnd=d.boostEnd||0; lastCalc=d.lastCalc||Date.now();
  totalSessions=d.totalSessions||0; referralCount=d.referralCount||0; adIndex=d.adIndex||0; activity=d.activity||[]; claims=Array.isArray(d.claims)?d.claims:[]; totalEarned=(typeof d.totalEarned==='number')?d.totalEarned:balance;
  referredBy=d.referredBy||""; claimedSessions=d.claimedSessions||0; dailyStreak=d.dailyStreak||0; lastDailyDay=(d.lastDailyDay ?? -1);
  boostDay=(d.boostDay ?? -1); boostUses=d.boostUses||0;
  socialDone=Array.isArray(d.socialDone)?d.socialDone:[]; tapDay=(d.tapDay ?? -1); fuel=(d.fuel ?? FUEL_MAX); tapMult=d.tapMult||1; refLevelPaid=d.refLevelPaid||0; tapRoll();
  refSeen=d.refSeen||0; badgesSeen=Array.isArray(d.badgesSeen)?d.badgesSeen:null; milestonePaid=Array.isArray(d.milestonePaid)?d.milestonePaid:[]; refHist=(d.refHist&&typeof d.refHist==='object')?d.refHist:{}; ciDay=d.ciDay ?? -1; ciStreak=d.ciStreak||0; chDay=d.chDay ?? -1; chProg=d.chProg||{}; chDone=Array.isArray(d.chDone)?d.chDone:[]; dayHist=(d.dayHist&&typeof d.dayHist==='object')?d.dayHist:{}; histFirst=d.histFirst ?? -1; refPaid=Array.isArray(d.refPaid)?d.refPaid:[]; refQSent=!!d.refQSent; refFriendEarn=Number(d.refFriendEarn)||0; alertMark=(d.alertMark&&typeof d.alertMark==='object')?d.alertMark:{s:0,soon:0,done:0}; notifs=Array.isArray(d.notifs)?d.notifs:[]; Object.assign(settings,d.settings||{}); settings.saver=settings.saver||'auto'; applySaver(); applySettingsUI(); renderNotifs(); recordRefHist(); checkBadges(); renderMilestones(); renderRefChart(); renderCheckin(); renderChallenges();
  if(tgUser && !d.name){ profile.name=(tgUser.first_name+" "+(tgUser.last_name||"")).trim(); profile.firstName=tgUser.first_name; profile.lastName=tgUser.last_name||""; }
  loaded=true; window.__ready=true; const sc=$('secCheck'); if(sc) sc.remove();
  const firstTime = !d.seenWelcome;
  const sp=tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('ref');
  if(sp?.startsWith('ref_') && !d.referredBy){
    const refId=sp.slice(4);
    if(refId && refId!==uid){
      referredBy=refId;
      try{ await window.saveUserData(uid,{referredBy:refId}); await window.refCreate(uid,refId); }catch(e){}
    }
  }
  settle();
  saveNow(firstTime?{seenWelcome:true}:{});
  renderProfile(); renderActivity(); renderClaims(); setupShare(); render();
  if(firstTime) openSheet('welcomeModal');
  loadAnnouncements(); loadLeaderboard(); loadRefBoard();
  renderGift(); renderSocials(); checkReferrals();
  if(referredBy){ window.refEnsure(uid,referredBy).catch(()=>{}).then(()=>{ if(miningStart||totalSessions>=1) markReferralQualified(); }); }
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) checkReferrals(); });
  setInterval(loop,1000); setInterval(loadLeaderboard,60000); setInterval(loadRefBoard,60000); setInterval(checkReferrals,30000);
  setInterval(()=>{ if(!document.hidden){ settle(); saveNow({online:true,lastHeartbeat:Date.now()}); } },30000);
  document.addEventListener('visibilitychange',()=>{ if(document.hidden){ settle(); saveNow({online:false,lastHeartbeat:0}); } else { settle(); render(); } });
  window.addEventListener('pagehide',()=>{ settle(); saveNow({online:false,lastHeartbeat:0}); });
};

Object.assign(window,{ claimRefLevel, forgotSubmit, forgotConfirm, forgotCancel, openWeekly, openHistory, openSocial, claimCheckin, claimChallenge, saveSettings, claimSocial, tapBoost, authStep, claimDailyReward, closeSheet, dialAction, doLogin, genUserId, handleBooster, hideAuth, hideSuccess,
  openSheet, openSupport, savePhoto, saveProfile, switchTab, verifyAccount, showAuth, logout });

window.__appLoaded = true;
