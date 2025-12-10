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

const FIREBASE_CONFIG = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(FIREBASE_CONFIG)
});
const db = admin.firestore();

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function authMiddleware(req, res, next) {
  const token = req.cookies.token || req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).send('Unauthorized');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).send('Unauthorized');
  }
}

// تسجيل الدخول
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', token, { httpOnly: true });
    return res.json({ token });
  }
  res.status(401).send('Invalid credentials');
});

// استقبال اسم المستخدم من الصفحة الرئيسية
app.post('/api/enter', async (req, res) => {
  const { name } = req.body;
  await db.collection('entries').add({ name, timestamp: Date.now() });

  // إرسال رسالة تيليجرام
  fetch(`https://api.telegram.org/bot${process.env.Telegram_TOKEN_ID}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.Telegram_CHAT_ID,
      text: `دخل شخص للموقع واسمه: ${name}`
    })
  });
  res.json({ message: 'Welcome ' + name });
});

// إرسال البيانات من الداشبورد
app.post('/api/dashboard/data', authMiddleware, async (req, res) => {
  const { section, title, text, image } = req.body;
  await db.collection('sections').add({ section, title, text, image, timestamp: Date.now() });
  res.json({ success: true });
});

// جلب البيانات للصفحة الرئيسية
app.get('/api/data', async (req, res) => {
  const snapshot = await db.collection('sections').orderBy('timestamp', 'desc').get();
  const data = snapshot.docs.map(doc => doc.data());
  res.json(data);
});

// إنشاء قسم جديد
app.post('/api/dashboard/section', authMiddleware, async (req, res) => {
  const { sectionName } = req.body;
  await db.collection('sections').add({ section: sectionName, timestamp: Date.now() });
  res.json({ success: true });
});

app.listen(3000, () => console.log('Server running on port 3000'));
