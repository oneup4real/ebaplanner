// server.js
//require('dotenv').config(); // Load .env file for local dev (put this first!)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore'); // Firestore Client
const { Storage } = require('@google-cloud/storage'); // Google Cloud Storage Client
const Multer = require('multer'); // Middleware for handling multipart/form-data (file uploads)
const { format } = require('util'); // Node.js utility

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const db = new Firestore();
const eventsCollection = db.collection('events'); // Reference to your Firestore collection

// Google Cloud Storage Configuration
const GCS_BUCKET_NAME = 'ebaplanner_event_images'; // Your bucket name
const storage = new Storage(); // Assumes ADC provides credentials with GCS access
const bucket = storage.bucket(GCS_BUCKET_NAME);

// Multer configuration (for handling file uploads in memory)
const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Limit file size to 10MB
  },
});

// Password Check (reads from env var)
const APP_PASSWORD = process.env.APP_PASSWORD;

// --- Express App Initialization ---
const app = express();

// --- Middleware ---

// CORS Configuration - **ADJUST ALLOWED ORIGINS!**
const allowedOrigins = [
  'http://localhost:8080', // For local testing of the HTML file directly
  'http://localhost:5173', // Vite/React/Vue default dev port
  'https://YOUR_FIREBASE_PROJECT_ID.web.app', // Your deployed Firebase frontend URL (replace!)
  'https://YOUR_FIREBASE_PROJECT_ID.firebaseapp.com' // Possible alternate Firebase URL (replace!)
  // Add your custom domain if you have one
];
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl) or if origin is in whitelist
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
};
app.use(cors(corsOptions)); // Enable CORS *before* routes

// JSON Parser (for requests *without* file uploads, like auth check, PUT)
app.use(express.json());

// --- Helper Functions ---

/**
 * Uploads a file buffer to Google Cloud Storage.
 * @param {Buffer} buffer The file buffer.
 * @param {string} originalname The original filename.
 * @param {string} mimetype The file mimetype.
 * @returns {Promise<string>} A promise that resolves with the public URL of the uploaded file.
 */
function uploadToGcs(buffer, originalname, mimetype) {
  return new Promise((resolve, reject) => {
    const uniqueFilename = `${Date.now()}-${originalname.replace(/ /g, '_')}`; // Create unique filename
    const blob = bucket.file(uniqueFilename);
    const blobStream = blob.createWriteStream({
      metadata: {
        contentType: mimetype,
      },
      resumable: false,
    });

    blobStream.on('error', (err) => {
      console.error("GCS Upload Error:", err);
      reject(`Error uploading to GCS: ${err.message}`);
    });

    blobStream.on('finish', async () => {
      try {
        // Make the file publicly readable (adjust if using Signed URLs)
        await blob.makePublic();
        const publicUrl = format(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
        console.log("GCS Upload successful:", publicUrl);
        resolve(publicUrl);
      } catch (err) {
        console.error("Error making file public or getting URL:", err);
        reject(`Error finalizing GCS upload: ${err.message}`);
      }
    });

    blobStream.end(buffer);
  });
}

/**
 * Deletes an object from Google Cloud Storage using its public URL.
 * @param {string} fileUrl The public URL of the file.
 * @returns {Promise<void>}
 */
async function deleteFromGcs(fileUrl) {
    if (!fileUrl || !fileUrl.startsWith(`https://storage.googleapis.com/${bucket.name}/`)) {
        console.warn(`Invalid or non-GCS URL provided for deletion: ${fileUrl}`);
        return; // Don't try to delete if URL is invalid or not from our bucket
    }
    try {
        const fileName = fileUrl.substring(`https://storage.googleapis.com/${bucket.name}/`.length);
        console.log(`Attempting to delete GCS object: ${fileName}`);
        await bucket.file(fileName).delete();
        console.log(`Successfully deleted GCS object: ${fileName}`);
    } catch (error) {
        // Log error but don't necessarily fail the whole request if GCS delete fails
        console.error(`Failed to delete GCS object ${fileUrl}:`, error.message);
        // Consider logging severity based on error code (e.g., ignore 'Not Found' errors)
        // if (error.code !== 404) { /* log more seriously */ }
    }
}

// --- API Endpoints ---

// GET /api/events - Fetches all events from Firestore
app.get('/api/events', async (req, res) => {
  console.log('API GET /api/events called');
  try {
    const snapshot = await eventsCollection
      .orderBy('eventDate', 'asc') // Sort by the Timestamp field
      .orderBy('startTime', 'asc') // Secondary sort by start time string
      .get();

    if (snapshot.empty) {
      console.log('No events found in Firestore.');
      return res.json([]);
    }

    const events = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Convert Firestore Timestamps back to a usable format for frontend (ISO String YYYY-MM-DD)
      events.push({
        id: doc.id, // Include Firestore document ID
        ...data,
        eventDate: data.eventDate?.toDate()?.toISOString()?.split('T')[0] || null,
        createdAt: data.createdAt?.toDate()?.toISOString() || null
      });
    });

    console.log(`${events.length} events fetched from Firestore.`);
    res.json(events);

  } catch (error) {
    console.error("Error in GET /api/events:", error.message, error.stack);
    res.status(500).json({ error: "Error loading events from database." });
  }
});

// POST /api/events - Adds a new event (with optional image upload)
// Uses multer middleware *only* for this route to handle multipart/form-data
app.post('/api/events', multer.single('eventImage'), async (req, res) => {
  // 'eventImage' must match the 'name' attribute of the file input in the frontend form
  console.log('API POST /api/events called');
  try {
    const eventData = req.body; // Text fields are in req.body
    const uploadedFile = req.file; // Uploaded file details (if any) are in req.file

    // Field names expected from FormData
    const FIELD_TITLE = 'title';
    const FIELD_DATE = 'eventDate'; // Expecting YYYY-MM-DD from input type="date"
    const FIELD_START_TIME = 'startTime';
    const FIELD_END_TIME = 'endTime';
    const FIELD_DESCRIPTION = 'description';
    const FIELD_RESOURCES = 'resources';
    const FIELD_RESPONSIBLE = 'responsible';
    const FIELD_EVENT_TYPE = 'eventType';
    const FIELD_PARTICIPANT_INFO = 'participantInfo';

    if (!eventData || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) {
       return res.status(400).json({ success: false, message: 'Title and Date are required fields.' });
    }

    let imageUrl = null;
    if (uploadedFile) {
      console.log("Processing uploaded file:", uploadedFile.originalname);
      // Upload to GCS and get public URL
      imageUrl = await uploadToGcs(uploadedFile.buffer, uploadedFile.originalname, uploadedFile.mimetype);
    }

    // Prepare data for Firestore
    // Convert date string (expecting YYYY-MM-DD from frontend) to Timestamp
    let eventDateTimestamp = null;
    if (eventData[FIELD_DATE]) {
        try {
            // Parse YYYY-MM-DD directly, assuming UTC for consistency on backend
            eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z'));
        } catch(e) {
             console.warn(`Could not parse date from frontend: ${eventData[FIELD_DATE]}`);
             return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' });
        }
    } else {
         return res.status(400).json({ success: false, message: 'Date is a required field.' });
    }

    const newEvent = {
      title: eventData[FIELD_TITLE] || '',
      eventDate: eventDateTimestamp,
      startTime: eventData[FIELD_START_TIME] || '',
      endTime: eventData[FIELD_END_TIME] || '',
      description: eventData[FIELD_DESCRIPTION] || '',
      resources: eventData[FIELD_RESOURCES] || '', // Comma-separated string from frontend
      responsible: eventData[FIELD_RESPONSIBLE] || '',
      eventType: eventData[FIELD_EVENT_TYPE] || 'Öffentlich', // Default if not provided
      participantInfo: eventData[FIELD_PARTICIPANT_INFO] || '',
      imageUrl: imageUrl, // Add the GCS URL if a file was uploaded
      createdAt: FieldValue.serverTimestamp() // Firestore server-side timestamp
    };

    const docRef = await eventsCollection.add(newEvent);
    console.log("New event successfully added to Firestore with ID:", docRef.id);
    res.status(201).json({ success: true, message: "Event added successfully.", id: docRef.id });

  } catch (error) {
    console.error("Error in POST /api/events:", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error adding event." });
  }
});


// PUT /api/events/:id - Updates an event in Firestore (ID instead of rowNum!)
// NOTE: This version does NOT handle image updates/replacements for simplicity. Expects JSON body.
app.put('/api/events/:id', async (req, res) => {
    const eventId = req.params.id;
    const eventData = req.body; // Expecting JSON body now
    console.log(`API PUT /api/events/${eventId} called`);

    // Field names expected from JSON body
    const FIELD_TITLE = 'title';
    const FIELD_DATE = 'eventDate'; // Expecting YYYY-MM-DD
    const FIELD_START_TIME = 'startTime';
    const FIELD_END_TIME = 'endTime';
    const FIELD_DESCRIPTION = 'description';
    const FIELD_RESOURCES = 'resources';
    const FIELD_RESPONSIBLE = 'responsible';
    const FIELD_EVENT_TYPE = 'eventType';
    const FIELD_PARTICIPANT_INFO = 'participantInfo';

    if (!eventId) {
        return res.status(400).json({ error: 'Event ID missing.' });
    }
    if (!eventData || typeof eventData !== 'object' || Object.keys(eventData).length === 0 || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) {
        return res.status(400).json({ success: false, message: 'Invalid data or Title/Date missing.' });
    }

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'Event not found.' });
        }

        // Prepare update data (convert date)
        let eventDateTimestamp = null;
        if (eventData[FIELD_DATE]) {
             try {
                 eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z')); // Assume UTC
             } catch(e) {
                  return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' });
             }
        } else {
             return res.status(400).json({ success: false, message: 'Date is a required field.' });
        }

        // Create update object - DO NOT update createdAt or imageUrl here
        const updatePayload = {
            title: eventData[FIELD_TITLE] || '',
            eventDate: eventDateTimestamp,
            startTime: eventData[FIELD_START_TIME] || '',
            endTime: eventData[FIELD_END_TIME] || '',
            description: eventData[FIELD_DESCRIPTION] || '',
            resources: eventData[FIELD_RESOURCES] || '', // Comma-separated string from frontend
            responsible: eventData[FIELD_RESPONSIBLE] || '',
            eventType: eventData[FIELD_EVENT_TYPE] || 'Öffentlich',
            participantInfo: eventData[FIELD_PARTICIPANT_INFO] || '',
        };

        await eventRef.update(updatePayload);
        console.log(`Event ${eventId} successfully updated.`);
        res.json({ success: true, message: "Event updated successfully." });

    } catch (error) {
        console.error(`Error in PUT /api/events/${eventId}:`, error.message, error.stack);
        res.status(500).json({ success: false, message: "Error updating event." });
    }
});

// DELETE /api/events/:id - Deletes an event from Firestore (and optionally image from GCS)
app.delete('/api/events/:id', async (req, res) => {
    const eventId = req.params.id;
    console.log(`API DELETE /api/events/${eventId} called`);

     if (!eventId) {
        return res.status(400).json({ error: 'Event ID missing.' });
    }

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();

        if (doc.exists) {
            // Optional: Delete associated image from GCS *before* deleting Firestore record
            const eventData = doc.data();
            if (eventData.imageUrl) {
                await deleteFromGcs(eventData.imageUrl); // Attempt to delete, handles errors internally
            }

            // Delete Firestore document
            await eventRef.delete();
            console.log(`Event ${eventId} successfully deleted from Firestore.`);
            res.json({ success: true, message: 'Event deleted successfully.' });
        } else {
             console.log(`Event ${eventId} not found for deletion.`);
             res.status(404).json({ success: false, message: 'Event not found.' }); // Send 404
        }
    } catch (error) {
        console.error(`Error in DELETE /api/events/${eventId}:`, error.message, error.stack);
        res.status(500).json({ success: false, message: "Error deleting event." });
    }
});


// POST /api/auth/check - Checks the password (unchanged)
app.post('/api/auth/check', (req, res) => {
    console.log('API POST /api/auth/check called');
    const { password: userPassword } = req.body;

    if (!APP_PASSWORD) {
        console.error("SECURITY WARNING: APP_PASSWORD environment variable not set!");
        return res.status(500).json({ error: 'Server configuration error.' });
    }
    if (typeof userPassword !== 'string') {
        return res.status(400).json({ error: 'Password missing or invalid format.' });
    }
    const isValid = (userPassword === APP_PASSWORD);
    console.log(`Password check result: ${isValid ? 'Success' : 'Failed'}`);
    res.json({ isValid: isValid });
});


// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT) {
      console.warn('WARNING: Application Default Credentials (ADC) not found. Authentication with GCP services will likely fail unless running on GCP.');
  }
   if (!APP_PASSWORD) {
       console.warn('WARNING: APP_PASSWORD environment variable is not set. Password check will fail.');
       console.warn('WARNING: For production, using Secret Manager for secrets is strongly recommended!');
   }
   // Check for GCS Bucket Name (optional startup check)
   if (!GCS_BUCKET_NAME){
        console.error('ERROR: GCS_BUCKET_NAME is not defined!');
   }
});
