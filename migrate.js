// import-from-sheet.js
require('dotenv').config();

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { Firestore, Timestamp, FieldValue } = require('@google-cloud/firestore');

// --- Configuration ---
const SPREADSHEET_ID = '1v213UqdChUATSQoTeOl_poaZj17MbXRAjk8nJXKzyXQ';
const SHEET_NAME = 'Formularantworten 1'; // Exact name of the sheet tab
const SHEET_RANGE = 'A:J'; // Adjust range to include all columns (A to J based on previous config)
const HEADER_ROW = 1; // Row number where headers are located
const FIRESTORE_COLLECTION = 'events'; // Target Firestore collection

// Column order/names *as they appear in the Google Sheet*
// Adjust this if your Sheet order differs slightly or you want to skip columns
const SHEET_COLUMN_ORDER = [
    'Wann findet der Event statt?', // A
    'Event Titel',                 // B
    'Wann starter der Event?',       // C
    'Wann ist der Event zu Ende?', // D
    'Um was geht es bei dem Event?', // E
    'Welche Ressourcen brauchst du?', // F
    'Wer ist für den Event Verantwortlich?', // G
    'Event Typ',                   // H
    'Zusatzinfo Teilnehmer',       // I (Previously 'Teilnehmer Info')
    'Zeitstempel'                  // J
];

// Mapping from Sheet Column Name to Firestore Field Name
// Use the keys your backend/frontend now expect
const fieldMapping = {
    'Event Titel': 'title',
    'Wann findet der Event statt?': 'eventDate', // Will be converted to Timestamp
    'Wann starter der Event?': 'startTime',
    'Wann ist der Event zu Ende?': 'endTime',
    'Um was geht es bei dem Event?': 'description',
    'Welche Ressourcen brauchst du?': 'resources',
    'Wer ist für den Event Verantwortlich?': 'responsible',
    'Event Typ': 'eventType',
    'Zusatzinfo Teilnehmer': 'participantInfo',
    // 'Zeitstempel': 'createdAt' // We might want Firestore to generate this
};


// --- Initialize Clients ---
const db = new Firestore();
const sheets = google.sheets('v4');

/**
 * Parses various date string formats from the sheet into a valid Date object.
 * Returns null if parsing fails.
 * (Simplified version focusing on expected formats)
 */
function parseSheetDate(dateValue) {
  if (!dateValue) return null;
  let dateStr = String(dateValue).trim();
  if (!dateStr) return null;
  let parts;

  // Try DD.MM.YYYY
  parts = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (parts) {
    try {
      // Month is 0-indexed in JS Date constructor (parts[2] is 1-12)
      const d = new Date(Date.UTC(parts[3], parts[2] - 1, parts[1]));
      if (!isNaN(d)) return d;
    } catch (e) {}
  }

  // Try YYYY-MM-DD
  parts = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
   if (parts) {
     try {
        const d = new Date(Date.UTC(parts[1], parts[2] - 1, parts[3]));
        if (!isNaN(d)) return d;
     } catch(e) {}
   }

  // Try MM/DD/YYYY
   parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
   if (parts) {
     try {
        const d = new Date(Date.UTC(parts[3], parts[1] - 1, parts[2]));
        if (!isNaN(d)) return d;
     } catch (e) {}
   }

  // Fallback attempt (less reliable)
  try {
    const d = new Date(dateStr);
    if (!isNaN(d)) return d;
  } catch (e) {}

  console.warn(`Could not parse date: "${dateStr}"`);
  return null;
}


/**
 * Main import function
 */
async function importData() {
  if (!SPREADSHEET_ID) {
    console.error("Error: GOOGLE_SPREADSHEET_ID is not set in .env file.");
    return;
  }

  console.log(`Starting import from Sheet ID: ${SPREADSHEET_ID}, Sheet: ${SHEET_NAME}`);

  try {
    // Authenticate for Sheets API
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    // Get data from Google Sheet
    console.log(`Workspaceing data from range: ${SHEET_NAME}!${SHEET_RANGE}`);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${SHEET_RANGE}`,
      valueRenderOption: 'FORMATTED_VALUE', // Get dates/numbers as strings
    });

    const rows = response.data.values;
    if (!rows || rows.length <= HEADER_ROW) {
      console.log("No data found in the sheet (or only header row).");
      return;
    }

    // Extract headers from the specified row
    const headers = rows[HEADER_ROW - 1].map(h => String(h).trim());
    // Get the actual data rows (after the header)
    const dataRows = rows.slice(HEADER_ROW);

    console.log(`Found ${headers.length} headers and ${dataRows.length} data rows.`);

    // --- Process and Write to Firestore using Batch Writes ---
    const collectionRef = db.collection(FIRESTORE_COLLECTION);
    let batch = db.batch();
    let writeCounter = 0;
    let batchCounter = 0;
    const batchSize = 400; // Firestore batch limit is 500 operations

    for (const row of dataRows) {
      // Skip empty rows
      if (row.every(cell => cell === null || String(cell).trim() === '')) {
        continue;
      }

      const eventObject = {};
      let hasRequiredData = false;

      headers.forEach((header, index) => {
        const firestoreField = fieldMapping[header];
        if (firestoreField && index < row.length) {
          const sheetValue = String(row[index] || '').trim();

          if (firestoreField === 'eventDate') {
            const parsedDate = parseSheetDate(sheetValue);
            if (parsedDate) {
              eventObject[firestoreField] = Timestamp.fromDate(parsedDate); // Convert to Firestore Timestamp
              hasRequiredData = true; // Assume date is required
            } else {
               eventObject[firestoreField] = null; // Or handle invalid dates differently
            }
          } else {
            eventObject[firestoreField] = sheetValue;
          }

          // Check if title is present (assume title is also required)
          if (firestoreField === 'title' && sheetValue !== '') {
              hasRequiredData = true;
          }
        }
      });

       // Add a server timestamp for creation if desired
       eventObject.createdAt = FieldValue.serverTimestamp();

      // Only add if essential data is present
      if (hasRequiredData) {
        const newDocRef = collectionRef.doc(); // Auto-generate Firestore ID
        batch.set(newDocRef, eventObject);
        writeCounter++;
        batchCounter++;

        // Commit batch when it reaches size limit
        if (batchCounter >= batchSize) {
          console.log(`Committing batch of ${batchCounter} events...`);
          await batch.commit();
          console.log(`Batch committed. Total processed: ${writeCounter}`);
          // Start a new batch
          batch = db.batch();
          batchCounter = 0;
        }
      } else {
          console.warn("Skipping row due to missing required data (e.g., Title or parsable Date):", row);
      }
    }

    // Commit any remaining writes in the last batch
    if (batchCounter > 0) {
      console.log(`Committing final batch of ${batchCounter} events...`);
      await batch.commit();
      console.log(`Final batch committed. Total processed: ${writeCounter}`);
    }

    console.log(`\nImport finished successfully! ${writeCounter} events imported to collection '${FIRESTORE_COLLECTION}'.`);

  } catch (error) {
    console.error("\nImport failed:");
    if (error.response?.data?.error) { // Handle potential Google API errors
         console.error("API Error Details:", JSON.stringify(error.response.data.error, null, 2));
    } else {
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
    }
  }
}

// Run the import function
importData();