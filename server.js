require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // store in memory then upload to Firebase

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

// Initialize Firebase Admin from FIREBASE_CONFIG environment variable (JSON string)
if (!process.env.FIREBASE_CONFIG) {
  console.error("FIREBASE_CONFIG not set in .env. Put your service account JSON there.");
  process.exit(1);
}
let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
} catch (e) {
  console.error("Failed to parse FIREBASE_CONFIG JSON:", e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
  storageBucket: firebaseConfig.project_id + ".appspot.com"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve files from root (they are in same folder)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Protect /dashboard: if not logged in -> redirect to /login
function checkAuthRedirect(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.redirect('/login');
  }
}

// Serve dashboard only if authenticated; otherwise redirect
app.get('/dashboard', checkAuthRedirect, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API: public endpoint to get current admin profile (for homepage)
app.get('/api/public/profile', async (req, res) => {
  try {
    const doc = await db.collection('admin').doc('profile').get();
    if (!doc.exists) return res.json({ exists: false, data: null });
    return res.json({ exists: true, data: doc.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// API: visitor submits their name (required). store in 'visitors' collection.
app.post('/api/visitor', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم الزائر مطلوب' });
  try {
    const docRef = await db.collection('visitors').add({
      name,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// AUTH: login - returns JWT in httpOnly cookie
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid credentials' });

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '12h' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
    return res.json({ success: true });
  } else {
    return res.status(401).json({ error: 'wrong credentials' });
  }
});

// AUTH: logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Middleware to protect API routes (for dashboard actions)
function checkAuthApi(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// ADMIN: get profile (protected)
app.get('/api/admin/profile', checkAuthApi, async (req, res) => {
  try {
    const doc = await db.collection('admin').doc('profile').get();
    if (!doc.exists) return res.json({ exists: false, data: null });
    res.json({ exists: true, data: doc.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// ADMIN: upload or update profile (protected). image is optional.
app.post('/api/admin/profile', checkAuthApi, upload.single('image'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const profileRef = db.collection('admin').doc('profile');
    const dataToSave = {
      name,
      description: description || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // if image provided, upload to storage
    if (req.file) {
      const file = req.file;
      // validate jpg
      const mimetype = file.mimetype;
      if (!['image/jpeg', 'image/jpg'].includes(mimetype)) {
        return res.status(400).json({ error: 'only jpg images allowed' });
      }
      const filename = `admin-profile-${Date.now()}.jpg`;
      const fileRef = bucket.file(filename);
      await fileRef.save(file.buffer, {
        metadata: { contentType: mimetype },
        public: true
      });
      // Make public and get url
      try {
        await fileRef.makePublic();
      } catch (e) {
        // ignore if already public
      }
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      dataToSave.imageUrl = publicUrl;
      dataToSave.imageName = filename;
    }

    await profileRef.set(dataToSave, { merge: true });

    const saved = await profileRef.get();
    res.json({ success: true, data: saved.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

// ADMIN: delete profile and image (protected)
app.delete('/api/admin/profile', checkAuthApi, async (req, res) => {
  try {
    const profileRef = db.collection('admin').doc('profile');
    const doc = await profileRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'not found' });
    const data = doc.data();

    // delete image from storage if exists
    if (data && data.imageName) {
      try {
        await bucket.file(data.imageName).delete();
      } catch (e) {
        console.warn('could not delete image from storage', e.message);
      }
    }

    await profileRef.delete();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// ADMIN: update fields (PUT) - accepts JSON { name, description } (protected)
app.put('/api/admin/profile', checkAuthApi, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name && !description) return res.status(400).json({ error: 'nothing to update' });
    const profileRef = db.collection('admin').doc('profile');
    const updateData = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await profileRef.set(updateData, { merge: true });
    const doc = await profileRef.get();
    res.json({ success: true, data: doc.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Serve any other static file in root (like css/js if you add)
app.get('/:file', (req, res, next) => {
  const f = req.params.file;
  const allowed = ['index.html', 'login.html', 'dashboard.html'];
  if (allowed.includes(f)) return res.sendFile(path.join(__dirname, f));
  next();
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
