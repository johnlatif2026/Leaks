require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
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
  credential: admin.credential.cert(firebaseConfig),
  storageBucket: firebaseConfig.project_id + ".appspot.com"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve HTML files
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/login', (req,res)=>res.sendFile(path.join(__dirname,'login.html')));

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

// Dashboard route
app.get('/dashboard', checkAuthRedirect, (req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));

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
    res.status(500).json({error:'server error'});
  }
});

// Fetch all visitors (for dashboard)
app.get('/api/admin/visitors', checkAuthApi, async (req,res)=>{
  try{
    const snap = await db.collection('visitors').orderBy('createdAt','desc').get();
    const visitors = snap.docs.map(doc=>{
      const d = doc.data();
      return { id: doc.id, name: d.name, createdAt: d.createdAt?d.createdAt.toDate() : null };
    });
    res.json({visitors});
  } catch(err){
    console.error('Visitors fetch error:', err);
    res.status(500).json({error:'server error'});
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
    res.status(500).json({error:'server error'});
  }
});

// Login API
app.post('/api/login',(req,res)=>{
  const {username,password} = req.body||{};
  if(!username||!password) return res.status(400).json({error:'invalid credentials'});
  if(username===ADMIN_USER && password===ADMIN_PASS){
    const token = jwt.sign({user:username}, JWT_SECRET, {expiresIn:'12h'});
    res.cookie('token', token, {httpOnly:true,sameSite:'lax'});
    return res.json({success:true});
  } else return res.status(401).json({error:'wrong credentials'});
});

// Logout
app.post('/api/logout',(req,res)=>{
  res.clearCookie('token');
  res.json({success:true});
});

// Admin API
app.get('/api/admin/profile', checkAuthApi, async (req,res)=>{
  try{
    const doc = await db.collection('admin').doc('profile').get();
    if(!doc.exists) return res.json({exists:false,data:null});
    res.json({exists:true,data:doc.data()});
  } catch(err){
    console.error(err);
    res.status(500).json({error:'server error'});
  }
});

// Upload/update profile (accept JPG + PNG)
app.post('/api/admin/profile', checkAuthApi, upload.single('image'), async (req,res)=>{
  try{
    const {name,description} = req.body;
    if(!name) return res.status(400).json({error:'name required'});
    const profileRef = db.collection('admin').doc('profile');
    const dataToSave = {
      name,
      description: description||'',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if(req.file){
      const file = req.file;
      const mimetype = (file.mimetype||'').toLowerCase();
      if(!['image/jpeg','image/jpg','image/pjpeg','image/png'].includes(mimetype))
        return res.status(400).json({error:'Only JPG/PNG allowed'});

      const ext = mimetype.includes('png') ? 'png' : 'jpg';
      const filename = `admin-profile-${Date.now()}.${ext}`;
      const fileRef = bucket.file(filename);

      try{
        await fileRef.save(file.buffer,{
          metadata:{contentType:mimetype},
          public:true
        });
        await fileRef.makePublic();
        dataToSave.imageUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
        dataToSave.imageName = filename;
      } catch(err){
        console.error('Firebase Storage upload error:', err);
        return res.status(500).json({error:'فشل رفع الصورة', details: err.message});
      }
    }

    await profileRef.set(dataToSave,{merge:true});
    const saved = await profileRef.get();
    res.json({success:true,data:saved.data()});

  } catch(err){
    console.error('Profile save error:', err);
    res.status(500).json({error:'server error',details:err.message});
  }
});

// Delete profile
app.delete('/api/admin/profile', checkAuthApi, async (req,res)=>{
  try{
    const profileRef = db.collection('admin').doc('profile');
    const doc = await profileRef.get();
    if(!doc.exists) return res.status(404).json({error:'not found'});
    const data = doc.data();

    if(data && data.imageName){
      try{ await bucket.file(data.imageName).delete(); } 
      catch(e){ console.warn('Could not delete image',e.message); }
    }

    await profileRef.delete();
    res.json({success:true});
  } catch(err){
    console.error('Profile delete error:', err);
    res.status(500).json({error:'server error'});
  }
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
        
