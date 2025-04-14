// server.js (Single Container Version - Firestore/GCS Backend + Static Frontend + Session Auth)

// Load .env file for local development environment variables (must be the first line)
require('dotenv').config();

const express = require('express');
const path = require('path'); // Required for serving static files and catch-all route
const session = require('express-session'); // *** NEW: For sessions ***
const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore'); // Firestore Client + Helpers
const { FirestoreStore } = require('@google-cloud/connect-firestore'); // *** NEW: Session Store ***
const { Storage } = require('@google-cloud/storage'); // Google Cloud Storage Client
const Multer = require('multer'); // Middleware for handling multipart/form-data (file uploads)
const { format } = require('util'); // Node.js utility

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const db = new Firestore(); // Initialize Firestore client
const eventsCollection = db.collection('events');

// Google Cloud Storage Configuration
const GCS_BUCKET_NAME = 'ebaplanner_event_images'; // ** VERIFY THIS BUCKET NAME IS CORRECT **
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET_NAME);

// Multer configuration
const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Password Check (from environment variable)
const APP_PASSWORD = process.env.APP_PASSWORD;
// Session Secret (MUST be set securely via Env Var or Secret Manager in production)
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-insecure-fallback-secret-replace-me!';

// --- Express App Initialization ---
const app = express();

// --- Middleware ---

// ** NO CORS needed for single-container setup **

// JSON Body Parser (needed for login, PUT /api/events/:id and POST /api/auth/check)
app.use(express.json());

// *** Session Configuration ***
if (SESSION_SECRET === 'a-very-insecure-fallback-secret-replace-me!' && process.env.NODE_ENV === 'production') {
    console.error('FATAL ERROR: SESSION_SECRET is not securely set for production!');
    // process.exit(1); // Optionally exit if not set in production
}
app.use(session({
    store: new FirestoreStore({ // Store sessions in Firestore
        dataset: db,
        kind: 'express-sessions', // Collection name for sessions in Firestore
    }),
    secret: SESSION_SECRET, // Secret to sign the session ID cookie
    resave: false, // Don't save back if unmodified
    saveUninitialized: false, // Don't save empty sessions
    cookie: {
        maxAge: 1000 * 60 * 60, // Session expiration: 1 hour in milliseconds
        secure: process.env.NODE_ENV === 'production', // Send cookie only over HTTPS in production
        httpOnly: true, // Prevent client-side JS access to cookie
        // sameSite: 'lax' // Good default for CSRF protection
    }
}));

// *** Static File Serving ***
// Serve static files (index.html, stylesheet.css, etc.) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper Functions ---

// uploadToGcs(buffer, originalname, mimetype) - Unchanged from previous
async function uploadToGcs(buffer, originalname, mimetype) {
  return new Promise((resolve, reject) => {
    const uniqueFilename = `${Date.now()}-${originalname.replace(/ /g, '_')}`;
    const blob = bucket.file(uniqueFilename);
    const blobStream = blob.createWriteStream({ metadata: { contentType: mimetype }, resumable: false });
    blobStream.on('error', (err) => { console.error("GCS Upload Error:", err); reject(`Error uploading to GCS: ${err.message}`); });
    blobStream.on('finish', async () => {
      try { await blob.makePublic(); const publicUrl = format(`https://storage.googleapis.com/${bucket.name}/${blob.name}`); console.log("GCS Upload successful, public URL:", publicUrl); resolve(publicUrl); }
      catch (err) { console.error("Error making file public or getting URL:", err); reject(`Error finalizing GCS upload: ${err.message}`); }
    });
    blobStream.end(buffer);
  });
}

// deleteFromGcs(fileUrl) - Unchanged from previous
async function deleteFromGcs(fileUrl) {
    const gcsPrefix = `https://storage.googleapis.com/${bucket.name}/`;
    if (!fileUrl || !fileUrl.startsWith(gcsPrefix)) { console.warn(`Invalid GCS URL for deletion: ${fileUrl}`); return; }
    try {
        const fileName = fileUrl.substring(gcsPrefix.length);
        if (!fileName) { console.warn(`Could not extract filename from URL: ${fileUrl}`); return; }
        console.log(`Attempting to delete GCS object: ${fileName}`); await bucket.file(fileName).delete(); console.log(`Successfully deleted GCS object: ${fileName}`);
    } catch (error) { console.error(`Failed to delete GCS object ${fileUrl}:`, error.message); }
}

// *** NEW: Authentication Middleware ***
function isAuthenticated(req, res, next) {
    if (req.session && req.session.isAuthenticated) {
        // User has a valid session, proceed to the route handler
        return next();
    } else {
        // No valid session, send unauthorized error
        console.warn("Unauthorized access attempt blocked.");
        res.status(401).json({ error: 'Unauthorized. Please log in first.' });
    }
}

// --- API Endpoints ---

// GET /api/events - Fetches all events (Publicly accessible)
app.get('/api/events', async (req, res) => {
  console.log('API GET /api/events called');
  try {
    const snapshot = await eventsCollection.orderBy('eventDate', 'asc').orderBy('startTime', 'asc').get();
    const events = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      events.push({ id: doc.id, ...data, eventDate: data.eventDate?.toDate()?.toISOString()?.split('T')[0] || null, createdAt: data.createdAt?.toDate()?.toISOString() || null });
    });
    console.log(`${events.length} events fetched from Firestore.`);
    res.json(events);
  } catch (error) {
    console.error("Error in GET /api/events:", error.message, error.stack);
    res.status(500).json({ error: "Error loading events from database." });
  }
});

// POST /api/events - Adds a new event (Requires Authentication)
// Applies session check *then* multer
app.post('/api/events', isAuthenticated, multer.single('eventImage'), async (req, res) => {
  console.log('API POST /api/events called');
  try {
    const eventData = req.body; const uploadedFile = req.file;
    const FIELD_TITLE = 'title'; const FIELD_DATE = 'eventDate'; // ... (define other FIELD_* constants needed from FormData)
    const FIELD_START_TIME = 'startTime'; const FIELD_END_TIME = 'endTime'; const FIELD_DESCRIPTION = 'description'; const FIELD_RESOURCES = 'resources'; const FIELD_RESPONSIBLE = 'responsible'; const FIELD_EVENT_TYPE = 'eventType'; const FIELD_PARTICIPANT_INFO = 'participantInfo';

    if (!eventData || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) { return res.status(400).json({ success: false, message: 'Title and Date are required fields.' }); }

    let imageUrl = null;
    if (uploadedFile) { imageUrl = await uploadToGcs(uploadedFile.buffer, uploadedFile.originalname, uploadedFile.mimetype); }

    let eventDateTimestamp = null;
    if (eventData[FIELD_DATE]) { try { eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z')); } catch(e) { return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' }); } }
    else { return res.status(400).json({ success: false, message: 'Date is a required field.' }); }

    const newEvent = { title: eventData[FIELD_TITLE] || '', eventDate: eventDateTimestamp, startTime: eventData[FIELD_START_TIME] || '', endTime: eventData[FIELD_END_TIME] || '', description: eventData[FIELD_DESCRIPTION] || '', resources: eventData[FIELD_RESOURCES] || '', responsible: eventData[FIELD_RESPONSIBLE] || '', eventType: eventData[FIELD_EVENT_TYPE] || 'Öffentlich', participantInfo: eventData[FIELD_PARTICIPANT_INFO] || '', imageUrl: imageUrl, createdAt: FieldValue.serverTimestamp() };
    const docRef = await eventsCollection.add(newEvent);
    console.log("New event added to Firestore with ID:", docRef.id);
    res.status(201).json({ success: true, message: "Event added successfully.", id: docRef.id });
  } catch (error) { console.error("Error in POST /api/events:", error.message, error.stack); res.status(500).json({ success: false, message: "Error adding event." }); }
});


// PUT /api/events/:id - Updates an event (Requires Authentication, handles image update)
// Applies session check *then* multer
app.put('/api/events/:id', isAuthenticated, multer.single('eventImage'), async (req, res) => {
    const eventId = req.params.id; const eventData = req.body; const newImageFile = req.file;
    console.log(`API PUT /api/events/${eventId} called`);
    const FIELD_TITLE = 'title'; const FIELD_DATE = 'eventDate'; // ... define other FIELD_* constants needed from FormData
    const FIELD_START_TIME = 'startTime'; const FIELD_END_TIME = 'endTime'; const FIELD_DESCRIPTION = 'description'; const FIELD_RESOURCES = 'resources'; const FIELD_RESPONSIBLE = 'responsible'; const FIELD_EVENT_TYPE = 'eventType'; const FIELD_PARTICIPANT_INFO = 'participantInfo';

    if (!eventId) return res.status(400).json({ error: 'Event ID missing.' });
    if (!eventData || typeof eventData !== 'object' || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) { return res.status(400).json({ success: false, message: 'Invalid data or Title/Date missing.' }); }

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();
        if (!doc.exists) { return res.status(404).json({ success: false, message: 'Event not found.' }); }

        const existingData = doc.data();
        let imageUrlToUpdate = existingData.imageUrl;

        if (newImageFile) {
            console.log("Processing new image upload for update:", newImageFile.originalname);
            if (existingData.imageUrl) { await deleteFromGcs(existingData.imageUrl); }
            imageUrlToUpdate = await uploadToGcs(newImageFile.buffer, newImageFile.originalname, newImageFile.mimetype);
            console.log("New image uploaded, URL:", imageUrlToUpdate);
        }

        let eventDateTimestamp = null;
        if (eventData[FIELD_DATE]) { try { eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z')); } catch(e) { return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' }); } }
        else { return res.status(400).json({ success: false, message: 'Date is a required field.' }); }

        const updatePayload = { title: eventData[FIELD_TITLE] || '', eventDate: eventDateTimestamp, startTime: eventData[FIELD_START_TIME] || '', endTime: eventData[FIELD_END_TIME] || '', description: eventData[FIELD_DESCRIPTION] || '', resources: eventData[FIELD_RESOURCES] || '', responsible: eventData[FIELD_RESPONSIBLE] || '', eventType: eventData[FIELD_EVENT_TYPE] || 'Öffentlich', participantInfo: eventData[FIELD_PARTICIPANT_INFO] || '', imageUrl: imageUrlToUpdate };

        // Clean payload from undefined values before update (Firestore doesn't like undefined)
         Object.keys(updatePayload).forEach(key => {
             if (updatePayload[key] === undefined) {
                 // If a field wasn't present in FormData, default to deleting it? Or keep existing?
                 // Let's keep existing by just not including it in the final update sent to Firestore
                 // A safer approach is to only include fields that ARE present in eventData
                 // For now, this simple object construction assumes all text fields are sent.
                 // We need to handle imageUrl specifically if it should be removed.
                 if (key === 'imageUrl' && imageUrlToUpdate === null) {
                     updatePayload[key] = FieldValue.delete(); // Use FieldValue.delete() to remove field
                 } else if (updatePayload[key] === undefined) {
                     // If other fields could be optional, delete them from payload too
                     delete updatePayload[key];
                 }
             }
          });
         // Ensure imageUrl is explicitly handled if it should be removed. If imageUrlToUpdate is null/undefined, remove it.
         if (!imageUrlToUpdate && 'imageUrl' in updatePayload) {
             updatePayload.imageUrl = FieldValue.delete();
         }


        await eventRef.update(updatePayload);
        console.log(`Event ${eventId} successfully updated.`);
        res.json({ success: true, message: "Event updated successfully." });
    } catch (error) { console.error(`Error in PUT /api/events/${eventId}:`, error.message, error.stack); res.status(500).json({ success: false, message: "Error updating event." }); }
});

// DELETE /api/events/:id - Deletes Event from Firestore & GCS (Requires Authentication)
app.delete('/api/events/:id', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    console.log(`API DELETE /api/events/${eventId} called`);
    if (!eventId) return res.status(400).json({ error: 'Event ID missing.' });

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();
        if (doc.exists) { const eventData = doc.data(); if (eventData.imageUrl) { await deleteFromGcs(eventData.imageUrl); } await eventRef.delete(); console.log(`Event ${eventId} successfully deleted from Firestore.`); res.json({ success: true, message: 'Event deleted successfully.' }); }
        else { console.log(`Event ${eventId} not found for deletion.`); res.status(404).json({ success: false, message: 'Event not found.' }); }
    } catch (error) { console.error(`Error in DELETE /api/events/${eventId}:`, error.message, error.stack); res.status(500).json({ success: false, message: "Error deleting event." }); }
});

// DELETE /api/events/:id/image - Deletes only the image (Requires Authentication)
app.delete('/api/events/:id/image', isAuthenticated, async (req, res) => {
    const eventId = req.params.id;
    console.log(`API DELETE /api/events/${eventId}/image called`);
    if (!eventId) { return res.status(400).json({ error: 'Event ID missing.' }); }

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();
        if (!doc.exists) { return res.status(404).json({ success: false, message: 'Event not found.' }); }
        const eventData = doc.data();

        if (!eventData.imageUrl) { console.log(`Event ${eventId} has no image to delete.`); return res.json({ success: true, message: 'No image found for this event.' }); }

        await deleteFromGcs(eventData.imageUrl);
        await eventRef.update({ imageUrl: FieldValue.delete() }); // Remove field from Firestore

        console.log(`Image for event ${eventId} deleted successfully.`);
        res.json({ success: true, message: 'Image deleted successfully.' });
    } catch (error) { console.error(`Error in DELETE /api/events/${eventId}/image:`, error.message, error.stack); res.status(500).json({ success: false, message: "Error deleting image." }); }
});


// --- Authentication Endpoints ---

// POST /api/login - Creates a session if password is correct
app.post('/api/login', (req, res) => {
    console.log('API POST /api/login called');
    const { password } = req.body;

    if (!APP_PASSWORD) { console.error("APP_PASSWORD is not configured!"); return res.status(500).json({ success: false, message: 'Server configuration error.' }); }

    if (password && password === APP_PASSWORD) {
        req.session.isAuthenticated = true; // Mark session as authenticated
        req.session.user = { role: 'admin' }; // Store minimal user info
        console.log(`Login successful, session created/updated: ${req.session.id}`);
        req.session.save(err => { // Explicitly save session before responding
            if (err) { console.error("Session save error:", err); return res.status(500).json({ success: false, message: 'Session could not be saved.' }); }
            res.json({ success: true, message: 'Login successful.' });
        });
    } else {
        console.log('Login failed: Incorrect password');
        res.status(401).json({ success: false, message: 'Invalid password.' });
    }
});

// POST /api/logout - Destroys the current session
app.post('/api/logout', (req, res) => {
    console.log(`API POST /api/logout called for session: ${req.session.id}`);
    req.session.destroy(err => {
        if (err) {
            console.error("Error destroying session:", err);
            return res.status(500).json({ success: false, message: 'Logout failed.' });
        }
        // Standard cookie name for express-session is 'connect.sid'
        res.clearCookie('connect.sid'); // Adjust if cookie name was changed in session config
        console.log("Session destroyed");
        res.json({ success: true, message: 'Logout successful.' });
    });
});

// GET /api/auth/status - Checks if the current request has a valid session
app.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
         console.log(`Auth status check: User is authenticated (Session ID: ${req.session.id})`);
        res.json({ loggedIn: true, user: req.session.user });
    } else {
         console.log("Auth status check: User is not authenticated");
        res.json({ loggedIn: false });
    }
});

// *** Catch-All Route for Frontend ***
// This MUST be the LAST route istered
app.get('/*splat', (req, res) => {
  // It sends the main index.html file for any GET request that didn't match an API route or a static file
  console.log(`Catch-all route hit for ${req.path}, sending index.html`);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  // Startup Warnings
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT && process.env.NODE_ENV !== 'production') {
      // Warning only relevant for local development if not running on GCP
      console.warn('WARNING: Local ADC not found/configured (GOOGLE_APPLICATION_CREDENTIALS or gcloud login).');
  }
   if (!APP_PASSWORD) {
       console.warn('WARNING: APP_PASSWORD environment variable is not set. Login/protected routes will fail.');
   }
    if (!SESSION_SECRET || SESSION_SECRET === 'a-very-insecure-fallback-secret-replace-me!') {
       console.warn('WARNING: SESSION_SECRET is not securely set. Session cookies are insecure!');
   }
   if (!GCS_BUCKET_NAME){
        console.error('ERROR: GCS_BUCKET_NAME constant is not defined or empty!');
   }
});