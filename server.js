import express from "express";
import admin from "firebase-admin";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Firebase Admin init
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CONFIG))
  });
  console.log("Firebase Admin Initialized ✅");
} catch (err) {
  console.error("Firebase Admin init error:", err);
}

const db = admin.firestore();

// JWT Middleware
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Login API
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: "2h" });
    return res.json({ token });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// Notify API - إرسال رسالة Telegram
app.post("/api/notify", authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message
      })
    });
    const data = await tgRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Section
app.post("/api/section", authMiddleware, async (req, res) => {
  const { name, title, text, image } = req.body;
  if (!name || !title || !text) return res.status(400).json({ error: "Required fields missing" });
  try {
    const docRef = await db.collection(name).add({ title, text, image: image || "" });
    res.json({ id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all sections
app.get("/api/sections", authMiddleware, async (req, res) => {
  try {
    const collections = await db.listCollections();
    const result = [];

    for (const col of collections) {
      const snapshot = await col.get();
      snapshot.forEach(doc => {
        result.push({ collection: col.id, id: doc.id, ...doc.data() });
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Default route
app.get("/", (req, res) => res.send("Serverless Firebase + Telegram API Running ✅"));

export default app;
