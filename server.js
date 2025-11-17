require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// Initialize Firebase
if (!process.env.FIREBASE_CONFIG) {
  console.error("FIREBASE_CONFIG not set in .env");
  process.exit(1);
}

let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
} catch(e){
  console.error("Failed to parse FIREBASE_CONFIG JSON:", e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig)
});

const db = admin.firestore();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(__dirname)); // ليتمكن السيرفر من قراءة data.json

// Serve HTML
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/login', (req,res)=>res.sendFile(path.join(__dirname,'login.html')));
app.get('/dashboard', checkAuthRedirect, (req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));

// JWT auth middleware
function checkAuthRedirect(req,res,next){
  const token = req.cookies.token;
  if(!token) return res.redirect('/login');
  try { jwt.verify(token, JWT_SECRET); next(); } 
  catch(e){ return res.redirect('/login'); }
}

function checkAuthApi(req,res,next){
  const token = req.cookies.token;
  if(!token) return res.status(401).json({error:'not authenticated'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({error:'invalid token'}); }
}

// Visitors API
app.post('/api/visitor', async (req,res)=>{
  const name = (req.body.name||'').trim();
  if(!name) return res.status(400).json({error:'اسم الزائر مطلوب'});
  try {
    const docRef = await db.collection('visitors').add({
      name,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({success:true,id:docRef.id});
  } catch(err){
    console.error('Visitor save error:', err);
    res.status(500).json({error:'server error', details: err.message, stack: err.stack});
  }
});

app.get('/api/admin/visitors', checkAuthApi, async (req,res)=>{
  try{
    const snap = await db.collection('visitors').orderBy('createdAt','desc').get();
    const visitors = snap.docs.map(doc=>{
      const d = doc.data();
      return { id: doc.id, name: d.name, createdAt: d.createdAt ? d.createdAt.toDate() : null };
    });
    res.json({visitors});
  } catch(err){
    console.error('Visitors fetch error:', err);
    res.status(500).json({error:'server error', details: err.message, stack: err.stack});
  }
});

// Public profile API
app.get('/api/public/profile', async (req,res)=>{
  try{
    const doc = await db.collection('admin').doc('profile').get();
    if(!doc.exists) return res.json({exists:false,data:null});
    res.json({exists:true,data:doc.data()});
  } catch(err){
    console.error(err);
    res.status(500).json({error:'server error', details: err.message, stack: err.stack});
  }
});

// Login/Logout
app.post('/api/login',(req,res)=>{
  const {username,password} = req.body||{};
  if(!username||!password) return res.status(400).json({error:'invalid credentials'});
  if(username===ADMIN_USER && password===ADMIN_PASS){
    const token = jwt.sign({user:username}, JWT_SECRET, {expiresIn:'12h'});
    res.cookie('token', token, {httpOnly:true,sameSite:'lax'});
    return res.json({success:true});
  } else return res.status(401).json({error:'wrong credentials'});
});

app.post('/api/logout',(req,res)=>{
  res.clearCookie('token');
  res.json({success:true});
});

// Admin profile routes
app.get('/api/admin/profile', checkAuthApi, async (req,res)=>{
  try{
    const doc = await db.collection('admin').doc('profile').get();
    if(!doc.exists) return res.json({exists:false,data:null});
    res.json({exists:true,data:doc.data()});
  } catch(err){
    console.error(err);
    res.status(500).json({error:'server error', details: err.message, stack: err.stack});
  }
});

// Upload/update profile (Firestore for text, data.json for image)
app.post('/api/admin/profile', checkAuthApi, upload.single('image'), async (req,res)=>{
  try{
    const {name, description} = req.body;
    if(!name) return res.status(400).json({error:'name required'});

    // تحديث Firestore للنصوص
    const profileRef = db.collection('admin').doc('profile');
    await profileRef.set({
      name,
      description: description || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge:true});

    // تحديث الصورة في data.json
    const filePath = path.join(__dirname, 'data.json');
    let imageData = { imageBase64: "", imageMime: "" };
    if(req.file){
      imageData.imageBase64 = req.file.buffer.toString('base64');
      imageData.imageMime = req.file.mimetype;
    }
    fs.writeFileSync(filePath, JSON.stringify(imageData, null, 2));

    res.json({success:true, message: 'تم التحديث بنجاح'});
  } catch(err){
    console.error('Profile update error full:', err);
    res.status(500).json({
      error:'server error',
      details: err.message,
      stack: err.stack
    });
  }
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
