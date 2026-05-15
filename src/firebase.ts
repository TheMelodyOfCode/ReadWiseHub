import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyArbWHoYcBOP2ZVGL5BH7Kr-DsalktSoVY",
  authDomain: "readwisehub.firebaseapp.com",
  projectId: "readwisehub",
  storageBucket: "readwisehub.firebasestorage.app",
  messagingSenderId: "424589604683",
  appId: "1:424589604683:web:2d8e51cc93903c8a001ace",
  measurementId: "G-VQ2PNDS12Z",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
