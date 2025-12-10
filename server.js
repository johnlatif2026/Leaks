require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(__dirname));

let db;
try {
  const FIREBASE_CONFIG = JSON.parse(process.env.FIREBASE_CONFIG);
  admin.initializeApp({
    credential: admin.credential.cert(FIREBASE_CONFIG)
  });
  db = admin.firestore();
} catch (err) {
  console.error('Firebase initialization error:', err);
}

const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpassword';

function authMiddleware(req, res, next) {
  const token = req.cookies.token || req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// تسجيل الدخول
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '2h' });
      res.cookie('token', token, { httpOnly: true });
      return res.json({ token });
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// استقبال اسم المستخدم من الصفحة الرئيسية
app.post('/api/enter', async (req, res) => {
  try {
    const { name } = req.body;
    if (!db) throw new Error('Firestore not initialized');
    await db.collection('entries').add({ name, timestamp: Date.now() });

    // إرسال رسالة تيليجرام
    try {
      await fetch(`https://api.telegram.org/bot${process.env.Telegram_TOKEN_ID}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.Telegram_CHAT_ID,
          text: `دخل شخص للموقع واسمه: ${name}`
        })
      });
    } catch (err) {
      console.error('Telegram error:', err);
    }

    res.json({ message: 'Welcome ' + name });
  } catch (err) {
    console.error('Enter API error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// إرسال البيانات من الداشبورد
app.post('/api/dashboard/data', authMiddleware, async (req, res) => {
  try {
    const { section, title, text, image } = req.body;
    if (!db) throw new Error('Firestore not initialized');
    await db.collection('sections').add({ section, title, text, image, timestamp: Date.now() });
    res.json({ success: true });
  } catch (err) {
    console.error('Dashboard data error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// جلب البيانات للصفحة الرئيسية
app.get('/api/data', async (req, res) => {
  try {
    if (!db) throw new Error('Firestore not initialized');
    const snapshot = await db.collection('sections').orderBy('timestamp', 'desc').get();
    const data = snapshot.docs.map(doc => doc.data());
    res.json(data);
  } catch (err) {
    console.error('Get data error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// إنشاء قسم جديد
app.post('/api/dashboard/section', authMiddleware, async (req, res) => {
  try {
    const { sectionName } = req.body;
    if (!db) throw new Error('Firestore not initialized');
    await db.collection('sections').add({ section: sectionName, timestamp: Date.now() });
    res.json({ success: true });
  } catch (err) {
    console.error('Create section error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// على Vercel بيستخدم default port من process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
