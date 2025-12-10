import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";

const app = express();
app.use(express.json());

// Firebase Admin Init
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CONFIG))
  });
  console.log("Firebase Admin Initialized ✅");
} catch (err) {
  console.error("Firebase Admin init error:", err);
}

// Firestore reference
const db = admin.firestore();

// Middleware JWT حماية
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// تسجيل دخول Dashboard (مثال)
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  // هنا بدل authentication حقيقي ممكن تحط قاعدة بيانات للمستخدمين
  if (username === "admin" && password === "123456") {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return res.json({ token });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// إضافة قسم جديد
app.post("/api/section", authMiddleware, async (req, res) => {
  const { name, title, text, image } = req.body;
  try {
    const docRef = await db.collection(name).add({ title, text, image: image || "" });
    res.json({ id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// إرسال إشعار على Telegram
app.post("/api/notify", authMiddleware, async (req, res) => {
  const { message } = req.body;
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message })
    });
    const data = await tgRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Default route
app.get("/", (req, res) => res.send("Serverless Firebase + Telegram API Running ✅"));

// Vercel: export as default
export default app;
