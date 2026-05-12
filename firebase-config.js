import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, query, collection, where, getDocs, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBuh8Mwiw38UTfkIRFrSYam3Tq5GlO4r_I",
  authDomain: "moggable.firebaseapp.com",
  projectId: "moggable",
  storageBucket: "moggable.firebasestorage.app",
  messagingSenderId: "421199632182",
  appId: "1:421199632182:web:dbaf25580de4044134c597",
  measurementId: "G-GFWLS6LQEH"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

async function generateFriendCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const snap = await getDocs(query(collection(db, 'users'), where('friendCode', '==', code)));
    if (snap.empty) return code;
  }
  throw new Error('Could not generate unique friend code');
}

async function ensureUserDoc(firebaseUser) {
  const ref = doc(db, 'users', firebaseUser.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const friendCode = await generateFriendCode();
  const username = firebaseUser.displayName || 'Mogger_' + Math.random().toString(36).substr(2, 4).toUpperCase();
  const userData = {
    uid: firebaseUser.uid,
    username,
    friendCode,
    photoURL: firebaseUser.photoURL || '',
    elo: 100,
    wins: 0,
    losses: 0,
    createdAt: serverTimestamp()
  };
  await setDoc(ref, userData);
  return userData;
}

async function getUserByFriendCode(code) {
  const q = query(collection(db, 'users'), where('friendCode', '==', code.toUpperCase()));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

export { auth, db, doc, setDoc, provider, signInWithPopup, signOut, onAuthStateChanged, ensureUserDoc, getUserByFriendCode };
