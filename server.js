require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const cors = require('cors');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// Initialize Firebase Admin using JSON in env
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON is missing in .env');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Simple in-memory list of SSE clients
const sseClients = [];

// Helper: broadcast SSE event to dashboard clients
function broadcastEvent(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(payload); } catch (e) {}
  });
}

// Helper: send Telegram message
async function sendTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (err) {
    console.error('Telegram send failed:', err);
  }
}

// Serve static HTML files
const path = require('path');
app.use(express.static(path.join(__dirname, '/')));

// LOGIN API - issues JWT and sets httpOnly cookie
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, message: 'Invalid credentials' });
});

// LOGOUT
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Middleware - verify JWT from cookie or Authorization header
function authMiddleware(req, res, next) {
  const token = (req.cookies && req.cookies.token) || req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ ok: false, message: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Token invalid' });
  }
}

// SSE endpoint for dashboard to receive live events
app.get('/api/events', (req, res) => {
  // keep connection open
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// Homepage: user submits name -> save to Firestore and broadcast to SSE and Telegram
app.post('/api/entry', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, message: 'Name required' });
  const doc = {
    name,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await db.collection('entries').add(doc);

  // broadcast to dashboard clients
  broadcastEvent('new-entry', doc);

  // send Telegram
  const text = `New visitor: <b>${name}</b>`;
  sendTelegram(text);

  res.json({ ok: true });
});

// API: get latest entries
app.get('/api/entries', async (req, res) => {
  const snap = await db.collection('entries').orderBy('createdAt', 'desc').limit(50).get();
  const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ ok: true, entries: arr });
});

// API: get published posts (for homepage)
app.get('/api/posts', async (req, res) => {
  const snap = await db.collection('posts').orderBy('createdAt', 'desc').limit(50).get();
  const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ ok: true, posts: arr });
});

// API: publish a post (from dashboard) -- protected
app.post('/api/publish', authMiddleware, async (req, res) => {
  const { title, section, imageUrl, text } = req.body;
  const doc = {
    title: title || '',
    section: section || '',
    imageUrl: imageUrl || '',
    text: text || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    author: req.user.username
  };
  await db.collection('posts').add(doc);
  broadcastEvent('new-post', doc);
  res.json({ ok: true });
});

// API: create section (protected)
app.post('/api/sections', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, message: 'Section name required' });
  const doc = { name, createdAt: admin.firestore.FieldValue.serverTimestamp() };
  await db.collection('sections').add(doc);
  res.json({ ok: true });
});

// API: list sections
app.get('/api/sections', async (req, res) => {
  const snap = await db.collection('sections').orderBy('createdAt', 'asc').get();
  const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ ok: true, sections: arr });
});

// Serve /dashboard only if cookie token valid, otherwise redirect to login
const cookieParser = require('cookie-parser');
app.use(cookieParser());

app.get('/dashboard', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login.html');
  try {
    jwt.verify(token, JWT_SECRET);
    return res.sendFile(path.join(__dirname, 'dashboard.html'));
  } catch (e) {
    return res.redirect('/login.html');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
