// server.js (Complete Single Container Version - Firestore/GCS Backend + Static Frontend)

// Load .env file for local development environment variables (must be the first lnine)
require('dotenv').config();

const express = require('express');
const path = require('path'); // Required for serving static files and catch-all route
const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore'); // Firestore Client + Helpers
const { Storage } = require('@google-cloud/storage'); // Google Cloud Storage Client
const Multer = require('multer'); // Middleware for handling multipart/form-data (file uploads)
const { format } = require('util'); // Node.js utility (used for formatting GCS URL)

// --- Configuration ---
const PORT = process.env.PORT || 8080; // Port to listen on (Cloud Run sets this automatically)
//const db = new Firestore(); // Initialize Firestore client (uses ADC)
const db = new Firestore({
  projectId: 'eba-bar-event-planner',
});
console.log(`DEBUG: Explicitly using Firestore project: ${db.projectId}`); // Log it
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

// ** NO CORS needed for single-container setup **

// JSON Body Parser (needed for PUT /api/events/:id and POST /api/auth/check)
// Place before routes that need to parse JSON bodies
app.use(express.json());

// *** Static File Serving ***
// Serve static files (index.html, stylesheet.css, etc.) from the 'public' directory
// Assumes 'public' folder is at the same level as server.js
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
        // Make the file publicly readable (Requires correct IAM/Bucket settings)
        //await blob.makePublic();
        const publicUrl = format(`https://storage.googleapis.com/${bucket.name}/${blob.name}`);
        console.log("GCS Upload successful, public URL:", publicUrl);
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
 * Logs errors but does not throw, to avoid blocking event deletion if GCS fails.
 * @param {string} fileUrl The public URL of the file (must start with gs://<bucket-name>/).
 * @returns {Promise<void>}
 */
async function deleteFromGcs(fileUrl) {
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
        console.error(`Failed to delete GCS object ${fileUrl}:`, error.message);
        // Optionally check error.code === 404 to specifically ignore "Not Found"
    }
}

// --- API Endpoints ---

// GET /api/events - Fetches all events from Firestore
app.get('/api/events', async (req, res) => {
  console.log('API GET /api/events called');
  try {
    console.log('HEEELLLOOOOIIIIAAMMMHEEEEERRRREEE');
    const snapshot = await eventsCollection
      .orderBy('eventDate', 'asc') // Order by Firestore Timestamp
      .orderBy('startTime', 'asc') // Secondary sort by time string
      .get();
      console.log('HEEELLLOOOOIIIIAAMMMHEEEEERRRREEE IAAM THEEERREE');

    const events = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Convert Firestore Timestamps back to YYYY-MM-DD for the frontend
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
             return res.status(400).json({ success: false, message: 'Invalid date format. Please use YYYY-MM-DD.' });
        }
    } else {
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
app.put('/api/events/:id', multer.single('eventImage'), async (req, res) => {
  const eventId = req.params.id;
  const eventData = req.body; // Textfelder kommen aus FormData body
  const newImageFile = req.file; // Neue Datei (falls hochgeladen) ist hier
  console.log(`API PUT /api/events/${eventId} called`);

  // Konstanten für Feldnamen (erwartet von FormData)
  const FIELD_TITLE = 'title';
  const FIELD_DATE = 'eventDate'; // Erwartet YYYY-MM-dd
  const FIELD_START_TIME = 'startTime';
  const FIELD_END_TIME = 'endTime';
  const FIELD_DESCRIPTION = 'description';
  const FIELD_RESOURCES = 'resources';
  const FIELD_RESPONSIBLE = 'responsible';
  const FIELD_EVENT_TYPE = 'eventType';
  const FIELD_PARTICIPANT_INFO = 'participantInfo';

  if (!eventId) return res.status(400).json({ error: 'Event ID fehlt.' });
  if (!eventData || typeof eventData !== 'object' || !eventData[FIELD_TITLE] || !eventData[FIELD_DATE]) {
      return res.status(400).json({ success: false, message: 'Ungültige Daten oder Titel/Datum fehlen.' });
  }

  try {
      const eventRef = eventsCollection.doc(eventId);
      const doc = await eventRef.get();
      if (!doc.exists) {
           return res.status(404).json({ success: false, message: 'Event nicht gefunden.' });
      }

      const existingData = doc.data();
      let imageUrlToUpdate = existingData.imageUrl; // Behalte standardmässig die alte URL

      // === NEU: Bild-Handling ===
      if (newImageFile) {
          console.log("Neues Bild wird verarbeitet:", newImageFile.originalname);
          // 1. Altes Bild aus GCS löschen, falls vorhanden
          if (existingData.imageUrl) {
              console.log("Lösche altes Bild aus GCS:", existingData.imageUrl);
              await deleteFromGcs(existingData.imageUrl); // Helferfunktion nutzen
          }
          // 2. Neues Bild nach GCS hochladen
          imageUrlToUpdate = await uploadToGcs(newImageFile.buffer, newImageFile.originalname, newImageFile.mimetype);
          console.log("Neues Bild hochgeladen, URL:", imageUrlToUpdate);
      }
      // Wenn kein neues Bild hochgeladen wurde, bleibt imageUrlToUpdate auf dem alten Wert.

      // Bereite Update-Daten vor (Konvertiere Datum)
      let eventDateTimestamp = null;
      if (eventData[FIELD_DATE]) {
           try { eventDateTimestamp = Timestamp.fromDate(new Date(eventData[FIELD_DATE] + 'T00:00:00Z')); }
           catch(e) { return res.status(400).json({ success: false, message: 'Ungültiges Datumsformat. Bitte YYYY-MM-dd verwenden.'}); }
      } else { return res.status(400).json({ success: false, message: 'Datum ist ein Pflichtfeld.'}); }

      // Update-Payload erstellen (inkl. neuer oder alter Bild-URL)
      // Wichtig: Firestore erlaubt keine 'undefined' Werte im Update, nur explizite Werte oder FieldValue.delete()
      const updatePayload = {
          title: eventData[FIELD_TITLE] !== undefined ? eventData[FIELD_TITLE] : FieldValue.delete(),
          eventDate: eventDateTimestamp, // Ist immer gesetzt oder Fehler vorher
          startTime: eventData[FIELD_START_TIME] !== undefined ? eventData[FIELD_START_TIME] : FieldValue.delete(),
          endTime: eventData[FIELD_END_TIME] !== undefined ? eventData[FIELD_END_TIME] : FieldValue.delete(),
          description: eventData[FIELD_DESCRIPTION] !== undefined ? eventData[FIELD_DESCRIPTION] : FieldValue.delete(),
          resources: eventData[FIELD_RESOURCES] !== undefined ? eventData[FIELD_RESOURCES] : FieldValue.delete(),
          responsible: eventData[FIELD_RESPONSIBLE] !== undefined ? eventData[FIELD_RESPONSIBLE] : FieldValue.delete(),
          eventType: eventData[FIELD_EVENT_TYPE] !== undefined ? eventData[FIELD_EVENT_TYPE] : FieldValue.delete(),
          participantInfo: eventData[FIELD_PARTICIPANT_INFO] !== undefined ? eventData[FIELD_PARTICIPANT_INFO] : FieldValue.delete(),
          // Setze imageUrl nur, wenn sie sich geändert hat ODER wenn sie explizit gelöscht wurde (hier nicht implementiert, aber imageUrlToUpdate enthält den korrekten neuen/alten/null Wert)
          // Wenn imageUrlToUpdate null ist (weil kein neues Bild und vorher keins da war oder es per X gelöscht wurde), wird es nicht gesetzt oder ggf. überschrieben, je nachdem wie man es implementiert.
          // Sicherer ist es, das Feld nur zu setzen, wenn es einen Wert hat ODER explizit zu löschen.
          // Diese einfache Version setzt immer den aktuellen Wert von imageUrlToUpdate:
          imageUrl: imageUrlToUpdate // Kann neu, alt oder null sein
      };

       // Entferne Felder, die nicht aktualisiert werden sollen oder null sind (ausser imageUrl)
      Object.keys(updatePayload).forEach(key => {
        if (updatePayload[key] === undefined) { // FormData sendet leere Felder als '' nicht undefined
          delete updatePayload[key];
        }
        // Speziell für imageUrl: Wenn imageUrlToUpdate null ist (weil kein neues Bild kam und vorher keins da war ODER es per X gelöscht wurde),
        // wollen wir das Feld in Firestore evtl. löschen oder auf null setzen.
        // Sicherer ist, es explizit mit FieldValue.delete() zu entfernen, wenn imageUrlToUpdate null ist.
        if (key === 'imageUrl' && imageUrlToUpdate === null) {
            updatePayload[key] = FieldValue.delete();
        }
      });


      // Update in Firestore durchführen
      await eventRef.update(updatePayload);
      console.log(`Event ${eventId} erfolgreich aktualisiert.`);
      res.json({ success: true, message: "Event erfolgreich aktualisiert." });

  } catch (error) {
      console.error(`Fehler in PUT /api/events/${eventId}:`, error.message, error.stack);
      res.status(500).json({ success: false, message: "Fehler beim Aktualisieren des Events." });
  }
});


app.delete('/api/events/:id/image', async (req, res) => {
  const eventId = req.params.id;
  console.log(`API DELETE /api/events/${eventId}/image called`);

  if (!eventId) {
      return res.status(400).json({ error: 'Event ID missing.' });
  }

  try {
      const eventRef = eventsCollection.doc(eventId);
      const doc = await eventRef.get();

      if (!doc.exists) {
          return res.status(404).json({ success: false, message: 'Event not found.' });
      }

      const eventData = doc.data();

      // Prüfen, ob überhaupt ein Bild vorhanden ist
      if (!eventData.imageUrl) {
          console.log(`Event ${eventId} has no image to delete.`);
          return res.json({ success: true, message: 'No image found for this event.' });
      }

      // 1. Bild aus GCS löschen
      console.log(`Attempting to delete image from GCS: ${eventData.imageUrl}`);
      await deleteFromGcs(eventData.imageUrl); // Uses existing helper function

      // 2. Feld in Firestore entfernen
      console.log(`Attempting to remove imageUrl field from Firestore document ${eventId}`);
      await eventRef.update({
          imageUrl: FieldValue.delete() // FieldValue.delete() entfernt das Feld
      });

      console.log(`Image for event ${eventId} deleted successfully.`);
      res.json({ success: true, message: 'Image deleted successfully.' });

  } catch (error) {
      console.error(`Error in DELETE /api/events/${eventId}/image:`, error.message);
      if (error.response?.data?.error) {
         console.error("Google API Error Details:", JSON.stringify(error.response.data.error, null, 2));
      } else {
         console.error("Stack:", error.stack);
      }
      res.status(500).json({ success: false, message: "Error deleting image." });
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


// *** Catch-All Route for Frontend ***
// This MUST be AFTER all your API routes.
// It serves the main index.html for any GET request that didn't match an API route or a static file in the /public folder.
app.get('/*splat', (req, res) => {
  // Assumes index.html is in the 'public' directory at the project root
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  // Startup Warnings
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