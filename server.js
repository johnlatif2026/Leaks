const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const multer = require('multer');
const admin = require('firebase-admin');
const path = require('path');

dotenv.config();
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Firebase
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CONFIG))
});
const db = admin.firestore();
const storage = admin.storage().bucket();

// Multer للإرتفاع الصور
const upload = multer({ storage: multer.memoryStorage() });

// Middleware للتحقق من JWT
function authenticateToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.redirect('/login.html');

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.redirect('/login.html');
    req.user = user;
    next();
  });
}

// صفحات HTML ثابتة
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/dashboard', authenticateToken, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// تسجيل دخول الادمن
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.USERNAME && password === process.env.PASSWORD) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.json({ token });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

// إضافة/تعديل بيانات الادمن
app.post('/api/data', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { name, description } = req.body;
    let imageUrl = null;

    if (req.file) {
      const file = storage.file(`images/${Date.now()}-${req.file.originalname}`);
      await file.save(req.file.buffer, { contentType: req.file.mimetype });
      imageUrl = `https://storage.googleapis.com/${storage.name}/${file.name}`;
    }

    const docRef = db.collection('adminData').doc('main');
    await docRef.set({
      name,
      description,
      imageUrl,
      updatedAt: new Date().toISOString()
    });

    res.json({ message: 'Data uploaded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب بيانات الادمن للصفحة الرئيسية
app.get('/api/data', async (req, res) => {
  const doc = await db.collection('adminData').doc('main').get();
  if (!doc.exists) return res.json({});
  res.json(doc.data());
});

// اعادة توجيه اذا حاول حد يدخل /dashboard بدون JWT
app.use((req, res, next) => {
  if (req.path === '/dashboard') return res.redirect('/login');
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
