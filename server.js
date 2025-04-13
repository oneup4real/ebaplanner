// server.js (Single Container Version with Firestore, GCS, Static Serving)

// Load .env file for local development environment variables (must be the first line)
require('dotenv').config();

const express = require('express');
const path = require('path'); // Required for serving static files
const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore'); // Firestore Client
const { Storage } = require('@google-cloud/storage'); // Google Cloud Storage Client
const Multer = require('multer'); // Middleware for handling multipart/form-data (file uploads)
const { format } = require('util'); // Node.js utility

// --- Configuration ---
const PORT = process.env.PORT || 8080; // Port to listen on (Cloud Run sets this automatically)
const db = new Firestore(); // Initialize Firestore client (uses ADC)
const eventsCollection = db.collection('events'); // Reference to your Firestore 'events' collection

// Google Cloud Storage Configuration
const GCS_BUCKET_NAME = 'ebaplanner_event_images'; // ** VERIFY THIS BUCKET NAME IS CORRECT **
const storage = new Storage(); // Initialize GCS client (uses ADC)
const bucket = storage.bucket(GCS_BUCKET_NAME);

// Multer configuration (for handling file uploads in memory)
const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Limit file size to 10MB
  },
});

// Password Check (reads from environment variable, set via Cloud Run Secret or .env)
const APP_PASSWORD = process.env.APP_PASSWORD;

// --- Express App Initialization ---
const app = express();

// --- Middleware ---

// ** NO CORS needed here ** because frontend and backend are served from the same origin.

// JSON Parser (needed for PUT /api/events/:id and POST /api/auth/check)
app.use(express.json());

// *** Static File Serving ***
// Serve static files (index.html, stylesheet.css) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper Functions ---

/**
 * Uploads a file buffer to Google Cloud Storage and makes it public.
 * @param {Buffer} buffer The file buffer.
 * @param {string} originalname The original filename.
 * @param {string} mimetype The file mimetype.
 * @returns {Promise<string>} A promise that resolves with the public URL of the uploaded file.
 */
async function uploadToGcs(buffer, originalname, mimetype) {
  return new Promise((resolve, reject) => {
    // Create a unique filename to avoid overwriting
    const uniqueFilename = `${Date.now()}-${originalname.replace(/ /g, '_')}`;
    const blob = bucket.file(uniqueFilename);
    const blobStream = blob.createWriteStream({
      metadata: { contentType: mimetype },
      resumable: false,
    });

    blobStream.on('error', (err) => {
      console.error("GCS Upload Error:", err);
      reject(`Error uploading to GCS: ${err.message}`);
    });

    blobStream.on('finish', async () => {
      try {
        // Make the file publicly readable. Consider Signed URLs for more security.
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
 * Logs errors but does not throw to prevent blocking event deletion if GCS fails.
 * @param {string} fileUrl The public URL of the file (must start with gs://<bucket-name>/).
 * @returns {Promise<void>}
 */
async function deleteFromGcs(fileUrl) {
    // Ensure the URL points to the correct bucket before attempting deletion
    const gcsPrefix = `https://storage.googleapis.com/${bucket.name}/`;
    if (!fileUrl || !fileUrl.startsWith(gcsPrefix)) {
        console.warn(`Invalid or non-matching GCS URL provided for deletion: ${fileUrl}`);
        return;
    }
    try {
        const fileName = fileUrl.substring(gcsPrefix.length);
        if (!fileName) {
            console.warn(`Could not extract filename from URL: ${fileUrl}`);
            return;
        }
        console.log(`Attempting to delete GCS object: ${fileName}`);
        await bucket.file(fileName).delete();
        console.log(`Successfully deleted GCS object: ${fileName}`);
    } catch (error) {
        // Log error but don't fail the entire request (e.g., if file already deleted)
        console.error(`Failed to delete GCS object ${fileUrl}:`, error.message);
        // Optionally check error.code === 404 to specifically ignore "Not Found"
    }
}

// --- API Endpoints ---

// GET /api/events - Fetches all events from Firestore
app.get('/api/events', async (req, res) => {
  console.log('API GET /api/events called');
  try {
    const snapshot = await eventsCollection
      .orderBy('eventDate', 'asc') // Use the Firestore Timestamp field for sorting
      .orderBy('startTime', 'asc') // Secondary sort by string
      .get();

    const events = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Convert Firestore Timestamps back to YYYY-MM-DD for the frontend date input
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
  // 'eventImage' must match the 'name' attribute of the <input type="file"> in the frontend form
  console.log('API POST /api/events called');
  try {
    const eventData = req.body; // Text fields are parsed by multer into req.body
    const uploadedFile = req.file; // Uploaded file details (if any) are in req.file

    // Define keys expected in the FormData from the frontend
    const FIELD_TITLE = 'title';
    const FIELD_DATE = 'eventDate'; // Expecting YYYY-MM-DD from <input type="date">
    const FIELD_START_TIME = 'startTime';
    const FIELD_END_TIME = 'endTime';
    const FIELD_DESCRIPTION = 'description';
    const FIELD_RESOURCES = 'resources';
    const FIELD_RESPONSIBLE = 'responsible';
    const FIELD_EVENT_TYPE = 'eventType';
    const FIELD_PARTICIPANT_INFO = 'participantInfo';

    // Basic Validation
    if (!eventData || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) {
       return res.status(400).json({ success: false, message: 'Title and Date are required fields.' });
    }

    let imageUrl = null; // Variable to store the GCS image URL
    if (uploadedFile) {
      // If a file was uploaded, process it
      console.log("Processing uploaded file:", uploadedFile.originalname);
      imageUrl = await uploadToGcs(uploadedFile.buffer, uploadedFile.originalname, uploadedFile.mimetype);
    }

    // Prepare data for Firestore
    // Convert date string (expecting YYYY-MM-DD from frontend) to Firestore Timestamp
    let eventDateTimestamp = null;
    if (eventData[FIELD_DATE]) {
        try {
            // Parse YYYY-MM-DD directly, assume UTC for storage consistency
            eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z'));
        } catch(e) {
             console.warn(`Could not parse date from frontend: ${eventData[FIELD_DATE]}`);
             // Return a specific error if date parsing fails
             return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' });
        }
    } else {
         // This case should be caught by the initial validation, but belts and suspenders
         return res.status(400).json({ success: false, message: 'Date is a required field.' });
    }

    // Construct the object to save in Firestore
    const newEvent = {
      title: eventData[FIELD_TITLE] || '',
      eventDate: eventDateTimestamp, // Store as Timestamp
      startTime: eventData[FIELD_START_TIME] || '',
      endTime: eventData[FIELD_END_TIME] || '',
      description: eventData[FIELD_DESCRIPTION] || '',
      resources: eventData[FIELD_RESOURCES] || '', // Comma-separated string from checkboxes
      responsible: eventData[FIELD_RESPONSIBLE] || '',
      eventType: eventData[FIELD_EVENT_TYPE] || 'Öffentlich', // Default value if needed
      participantInfo: eventData[FIELD_PARTICIPANT_INFO] || '',
      imageUrl: imageUrl, // Store the GCS URL (will be null if no image uploaded)
      createdAt: FieldValue.serverTimestamp() // Use Firestore's server timestamp
    };

    // Add the new event document to the Firestore collection
    const docRef = await eventsCollection.add(newEvent);
    console.log("New event successfully added to Firestore with ID:", docRef.id);
    // Send success response back to the frontend
    res.status(201).json({ success: true, message: "Event added successfully.", id: docRef.id });

  } catch (error) {
    console.error("Error in POST /api/events:", error.message, error.stack);
    res.status(500).json({ success: false, message: "Error adding event." });
  }
});


// PUT /api/events/:id - Updates an existing event (ID instead of rowNum!)
// NOTE: This version does NOT handle image updates/replacements for simplicity. Expects JSON body.
app.put('/api/events/:id', async (req, res) => {
    const eventId = req.params.id; // Get Firestore document ID from URL parameter
    const eventData = req.body; // Expecting JSON data in the request body
    console.log(`API PUT /api/events/${eventId} called`);

    // Define keys expected in the JSON body from the frontend
    const FIELD_TITLE = 'title';
    const FIELD_DATE = 'eventDate'; // Expecting YYYY-MM-DD string
    const FIELD_START_TIME = 'startTime';
    const FIELD_END_TIME = 'endTime';
    const FIELD_DESCRIPTION = 'description';
    const FIELD_RESOURCES = 'resources';
    const FIELD_RESPONSIBLE = 'responsible';
    const FIELD_EVENT_TYPE = 'eventType';
    const FIELD_PARTICIPANT_INFO = 'participantInfo';

    // Validate input
    if (!eventId) {
        return res.status(400).json({ error: 'Event ID missing.' });
    }
    if (!eventData || typeof eventData !== 'object' || Object.keys(eventData).length === 0 || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) {
        return res.status(400).json({ success: false, message: 'Invalid data or Title/Date missing.' });
    }

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();

        // Check if the event exists
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'Event not found.' });
        }

        // Prepare update data (convert date string to Firestore Timestamp)
        let eventDateTimestamp = null;
        if (eventData[FIELD_DATE]) {
             try {
                 // Parse YYYY-MM-DD, assume UTC
                 eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z'));
             } catch(e) {
                  return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' });
             }
        } else {
             return res.status(400).json({ success: false, message: 'Date is a required field.' });
        }

        // Create the update object with fields to be modified
        // Exclude fields that shouldn't be updated here (like imageUrl, createdAt)
        const updatePayload = {
            title: eventData[FIELD_TITLE] || '',
            eventDate: eventDateTimestamp,
            startTime: eventData[FIELD_START_TIME] || '',
            endTime: eventData[FIELD_END_TIME] || '',
            description: eventData[FIELD_DESCRIPTION] || '',
            resources: eventData[FIELD_RESOURCES] || '', // Comma-separated string from checkboxes
            responsible: eventData[FIELD_RESPONSIBLE] || '',
            eventType: eventData[FIELD_EVENT_TYPE] || 'Öffentlich',
            participantInfo: eventData[FIELD_PARTICIPANT_INFO] || '',
        };

        // Perform the update in Firestore
        await eventRef.update(updatePayload);
        console.log(`Event ${eventId} successfully updated.`);
        // Send success response
        res.json({ success: true, message: "Event updated successfully." });

    } catch (error) {
        console.error(`Error in PUT /api/events/${eventId}:`, error.message, error.stack);
        res.status(500).json({ success: false, message: "Error updating event." });
    }
});

// DELETE /api/events/:id - Deletes an Event from Firestore & its image from GCS
app.delete('/api/events/:id', async (req, res) => {
    const eventId = req.params.id; // Get Firestore document ID
    console.log(`API DELETE /api/events/${eventId} called`);

    if (!eventId) {
        return res.status(400).json({ error: 'Event ID missing.' });
    }

    try {
        const eventRef = eventsCollection.doc(eventId);
        const doc = await eventRef.get();

        if (doc.exists) {
            // If event exists, get its data to check for an image URL
            const eventData = doc.data();

            // Attempt to delete the associated image from GCS if URL exists
            if (eventData.imageUrl) {
                await deleteFromGcs(eventData.imageUrl); // Handles errors internally
            }

            // Delete the Firestore document itself
            await eventRef.delete();
            console.log(`Event ${eventId} successfully deleted from Firestore.`);
            res.json({ success: true, message: 'Event deleted successfully.' });
        } else {
             // If document doesn't exist, report it
             console.log(`Event ${eventId} not found for deletion.`);
             res.status(404).json({ success: false, message: 'Event not found.' });
        }
    } catch (error) {
        console.error(`Error in DELETE /api/events/${eventId}:`, error.message, error.stack);
        res.status(500).json({ success: false, message: "Error deleting event." });
    }
});


// POST /api/auth/check - Checks the password (unchanged logic)
app.post('/api/auth/check', (req, res) => {
     console.log('API POST /api/auth/check called');
     const { password: userPassword } = req.body;

     // Check if APP_PASSWORD is configured
     if (!APP_PASSWORD) {
         console.error("SECURITY WARNING: APP_PASSWORD environment variable not set!");
         return res.status(500).json({ error: 'Server configuration error.' });
     }
     // Check if password was provided in request
     if (typeof userPassword !== 'string') {
         return res.status(400).json({ error: 'Password missing or invalid format.' });
     }
     // Simple string comparison
     const isValid = (userPassword === APP_PASSWORD);
     console.log(`Password check result: ${isValid ? 'Success' : 'Failed'}`);
     // Return validation result
     res.json({ isValid: isValid });
});


// *** ADDED CATCH-ALL ROUTE FOR FRONTEND ***
// This MUST be AFTER all your API routes.
// It serves the main index.html for any GET request that doesn't match an API route or a static file in the /public folder.
// This is important for handling browser refreshes or direct links if you were using frontend routing (though less critical for the current simple view switching).
app.get('*', (req, res) => {
  // Ensure the path points correctly to your index.html within the public folder
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  // Startup Warnings (unchanged)
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT) {
      console.warn('WARNING: Application Default Credentials (ADC) not found / configured. Authentication with GCP services will likely fail unless running on GCP (like Cloud Run with a service account).');
  }
   if (!APP_PASSWORD) {
       console.warn('WARNING: APP_PASSWORD environment variable is not set. Password check will fail.');
       console.warn('WARNING: For production, using Secret Manager for secrets is strongly recommended!');
   }
   if (!GCS_BUCKET_NAME){
        console.error('ERROR: GCS_BUCKET_NAME constant is not defined or empty!');
   }
});