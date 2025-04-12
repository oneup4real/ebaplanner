const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

// --- Konfiguration (aus neuem code.gs) ---

// WICHTIG: Für Cloud Run dringend empfohlen, die ID als Umgebungsvariable zu setzen!
// const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SPREADSHEET_ID = '1v213UqdChUATSQoTeOl_poaZj17MbXRAjk8nJXKzyXQ';

// WICHTIG: Für Cloud Run dringend empfohlen, das Passwort über Secret Manager zu verwalten!
const APP_PASSWORD = process.env.APP_PASSWORD; // Passwort aus Umgebungsvariable lesen

const SHEET_NAME = 'Formularantworten 1'; // <-- Prüfen und ggf. anpassen!
const HEADER_ROW = 1; // Zeilennummer der Überschriften (1-basiert)

// Spaltenreihenfolge - diese definiert, wie Daten gelesen und geschrieben werden!
const COLUMN_ORDER = [
    'Wann findet der Event statt?', // A
    'Event Titel',                 // B
    'Wann starter der Event?',       // C
    'Wann ist der Event zu Ende?', // D
    'Um was geht es bei dem Event?', // E
    'Welche Ressourcen brauchst du?', // F
    'Wer ist für den Event Verantwortlich?', // G
    'Event Typ',                   // H
    'Teilnehmer Info',               // I
    'Zeitstempel'                  // J
];

// Indizes und Spaltennamen basierend auf COLUMN_ORDER
const DATE_COLUMN_INDEX = COLUMN_ORDER.indexOf('Wann findet der Event statt?');
const COL_DATE = COLUMN_ORDER[0];
const COL_TITLE = COLUMN_ORDER[1];
const COL_START_TIME = COLUMN_ORDER[2];
const COL_END_TIME = COLUMN_ORDER[3];
const COL_DESCRIPTION = COLUMN_ORDER[4];
const COL_RESOURCES = COLUMN_ORDER[5];
const COL_RESPONSIBLE = COLUMN_ORDER[6];
const COL_EVENT_TYPE = COLUMN_ORDER[7];
const COL_PARTICIPANT_INFO = COLUMN_ORDER[8];
const COL_TIMESTAMP = COLUMN_ORDER[9];

// Bestimme den Bereich der zu aktualisierenden Spalten (alle außer Zeitstempel)
const UPDATE_COLUMN_END_LETTER = String.fromCharCode(65 + COLUMN_ORDER.indexOf(COL_PARTICIPANT_INFO)); // 65='A', Spalte H = A+7

// --- Express App Initialisierung ---
const app = express();
const PORT = process.env.PORT || 8080;

// --- Middleware ---
app.use(express.static(path.join(__dirname, '..', 'public'))); // Statische Dateien (HTML, CSS)
app.use(express.json()); // JSON Body Parser für POST/PUT

// --- Hilfsfunktionen ---

/**
 * Authentifiziert und erstellt einen Google Sheets API Client.
 * @param {boolean} readOnly Ob nur Lesezugriff benötigt wird.
 * @returns {Promise<object>} Ein Promise, das zum Sheets API Client auflöst.
 */
async function getAuthenticatedSheetsClient(readOnly = true) {
    const scopes = readOnly
        ? ['https://www.googleapis.com/auth/spreadsheets.readonly']
        : ['https://www.googleapis.com/auth/spreadsheets']; // Schreibzugriff benötigt

    const auth = new GoogleAuth({ scopes: scopes });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Parsed Datumsformate (kopiert aus code.gs, Logger ersetzt).
 * @param {string|Date} dateValue
 * @return {string|null} Datum als 'YYYY-MM-DD' oder null.
 */
function parseAndFormatDate(dateValue) {
    // ... (Funktion aus vorheriger Antwort oder deinem code.gs einfügen) ...
    // Stelle sicher, dass Logger.log durch console.warn oder console.log ersetzt ist.
    if (!dateValue) return null;
    let dateStr = String(dateValue).trim();
    if (!dateStr) return null;
    let parts;
    // DD.MM.YYYY
    parts = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (parts) { try { const d = parseInt(parts[1], 10), m = parseInt(parts[2], 10), y = parseInt(parts[3], 10); if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${('0' + m).slice(-2)}-${('0' + d).slice(-2)}`; } catch (e) { } }
    // YYYY-MM-DD
    parts = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (parts) { try { const d = parseInt(parts[3], 10), m = parseInt(parts[2], 10), y = parseInt(parts[1], 10); if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${('0' + m).slice(-2)}-${('0' + d).slice(-2)}`; } catch (e) { } }
    // MM/DD/YYYY
    parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (parts) { try { const m = parseInt(parts[1], 10), d = parseInt(parts[2], 10), y = parseInt(parts[3], 10); if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${('0' + m).slice(-2)}-${('0' + d).slice(-2)}`; } catch (e) { } }
    // Fallback mit new Date()
    try { const pd = new Date(dateStr); if (!isNaN(pd.getTime())) return pd.getFullYear() + '-' + ('0' + (pd.getMonth() + 1)).slice(-2) + '-' + ('0' + pd.getDate()).slice(-2); } catch (e) { }
    console.warn(`Datum konnte nicht in YYYY-MM-DD konvertiert werden: "${dateStr}"`);
    return null;
}


// --- API Endpunkte ---

// GET /api/events - Holt alle Events
app.get('/api/events', async (req, res) => {
    console.log('API GET /api/events aufgerufen');
    if (!SPREADSHEET_ID) return res.status(500).json({ error: 'Serverkonfiguration: Spreadsheet ID fehlt.' });

    try {
        const sheets = await getAuthenticatedSheetsClient(true); // Read-only
        const numColumns = COLUMN_ORDER.length;

        // 1. Header lesen
        const headerRange = `${SHEET_NAME}!${HEADER_ROW}:${HEADER_ROW}`;
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: headerRange,
        });
        const headers = headerResponse.data.values ? headerResponse.data.values[0].map(h => String(h).trim()) : [];
        if (headers.length === 0) {
            throw new Error(`Keine Header in Zeile ${HEADER_ROW} gefunden.`);
        }
        // Sicherstellen, dass die gelesenen Header mit COLUMN_ORDER übereinstimmen (optional, aber gut zur Fehlersuche)
        // console.log("Gelesene Header:", headers);
        // console.log("Erwartete Header:", COLUMN_ORDER);

        // 2. Daten lesen (ab Zeile nach Header)
        const startRow = HEADER_ROW + 1;
        const dataRange = `${SHEET_NAME}!A${startRow}:${String.fromCharCode(65 + numColumns - 1)}`; // Z.B. A2:I
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: dataRange,
            valueRenderOption: 'FORMATTED_VALUE',
            dateTimeRenderOption: 'SERIAL_NUMBER'
        });

        const values = response.data.values || [];
        console.log(`Daten aus ${SHEET_NAME} geholt. ${values.length} Datenzeilen empfangen.`);

        const events = [];
        values.forEach((row, index) => {
            let event = {};
            let hasData = false;
            const currentRowNum = startRow + index; // Aktuelle Zeilennummer im Sheet

            // Werte den Headern aus COLUMN_ORDER zuordnen
            COLUMN_ORDER.forEach((definedHeader, colIndex) => {
                // Finde den Index des Headers in den tatsächlich gelesenen Headern
                const actualHeaderIndex = headers.indexOf(definedHeader);
                let value = '';
                if (actualHeaderIndex !== -1 && actualHeaderIndex < row.length) {
                    // Nimm den Wert aus der entsprechenden Spalte der aktuellen Zeile
                    value = (row[actualHeaderIndex] !== null && typeof row[actualHeaderIndex] !== 'undefined') ? String(row[actualHeaderIndex]).trim() : '';
                }
                event[definedHeader] = value; // Speichere unter dem definierten Header-Namen
                if (value !== '') hasData = true;
            });

            if (hasData) {
                const dateValue = event[COL_DATE]; // Nimm den Wert aus der Datumsspalte
                event.sortableDate = parseAndFormatDate(dateValue);
                event.rowNum = currentRowNum; // Zeilennummer hinzufügen
                events.push(event);
            }
        });

        // Sortierung (wie in code.gs)
        events.sort((a, b) => {
            if (!a.sortableDate && !b.sortableDate) return 0;
            if (!a.sortableDate) return 1;
            if (!b.sortableDate) return -1;
            if (a.sortableDate < b.sortableDate) return -1;
            if (a.sortableDate > b.sortableDate) return 1;
            const startTimeA = String(a[COL_START_TIME] || '');
            const startTimeB = String(b[COL_START_TIME] || '');
            if (startTimeA < startTimeB) return -1;
            if (startTimeA > startTimeB) return 1;
            return 0;
        });

        console.log(`${events.length} Events verarbeitet und sortiert.`);
        res.json(events);

    } catch (error) {
        console.error("Fehler in GET /api/events:", error.message);
        console.error("Stack:", error.stack);
        let clientMessage = "Fehler beim Laden der Events.";
        if (error.response?.data?.error) {
            clientMessage += ` Details: ${error.response.data.error.message || error.message}`;
        } else { clientMessage += ` Details: ${error.message}`; }
        res.status(500).json({ error: clientMessage });
    }
});

// POST /api/events - Fügt ein neues Event hinzu
app.post('/api/events', async (req, res) => {
    console.log('API POST /api/events aufgerufen mit Body:', req.body);
    const eventData = req.body;

    if (!SPREADSHEET_ID) return res.status(500).json({ error: 'Serverkonfiguration: Spreadsheet ID fehlt.' });
    if (!eventData || typeof eventData !== 'object' || Object.keys(eventData).length === 0) {
        return res.status(400).json({ error: 'Ungültige oder fehlende Event-Daten im Request Body.' });
    }

    try {
        const sheets = await getAuthenticatedSheetsClient(false); // Write access

        // Erstelle die Zeile basierend auf COLUMN_ORDER
        const newRow = COLUMN_ORDER.map(columnName => {
            if (columnName === COL_TIMESTAMP) {
                return new Date().toISOString(); // Zeitstempel als ISO String
            }
            // Verwende den Wert aus eventData, falls vorhanden, sonst leer
            return eventData[columnName] !== undefined ? eventData[columnName] : "";
        });

        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A1`, // Sage Sheets, es soll an die erste leere Zeile anhängen
            valueInputOption: 'USER_ENTERED', // Behandelt Eingaben als ob sie vom Benutzer kommen (wichtig für Formeln etc., hier eher 'RAW')
            insertDataOption: 'INSERT_ROWS', // Fügt Zeilen ein
            resource: {
                values: [newRow] // Muss ein Array von Zeilen sein
            }
        });

        console.log("Neues Event erfolgreich hinzugefügt:", response.data);
        res.status(201).json({ success: true, message: "Event erfolgreich hinzugefügt." });

    } catch (error) {
        console.error("Fehler in POST /api/events:", error.message);
        console.error("Stack:", error.stack);
        let clientMessage = "Fehler beim Hinzufügen des Events.";
        if (error.response?.data?.error) {
            clientMessage += ` Details: ${error.response.data.error.message || error.message}`;
        } else { clientMessage += ` Details: ${error.message}`; }
        res.status(500).json({ success: false, message: clientMessage });
    }
});

// PUT /api/events/:rowNum - Aktualisiert ein Event
app.put('/api/events/:rowNum', async (req, res) => {
    const rowNum = parseInt(req.params.rowNum, 10);
    const eventData = req.body;
    console.log(`API PUT /api/events/${rowNum} aufgerufen mit Body:`, eventData);

    if (!SPREADSHEET_ID) return res.status(500).json({ error: 'Serverkonfiguration: Spreadsheet ID fehlt.' });
    if (isNaN(rowNum) || rowNum <= HEADER_ROW) { // Zeilennummer muss gültig sein
        return res.status(400).json({ error: 'Ungültige Zeilennummer angegeben.' });
    }
    if (!eventData || typeof eventData !== 'object' || Object.keys(eventData).length === 0) {
        return res.status(400).json({ error: 'Ungültige oder fehlende Event-Daten im Request Body.' });
    }

    try {
        const sheets = await getAuthenticatedSheetsClient(false); // Write access

        // Erstelle Array der Werte in korrekter Reihenfolge, ignoriere Zeitstempel
        const valuesToWrite = COLUMN_ORDER.map(header => {
            if (header === COL_TIMESTAMP) return null; // Zeitstempel nicht überschreiben
            // Nimm Wert aus eventData, falls vorhanden, sonst leer ''
            return eventData[header] !== undefined ? eventData[header] : "";
        }).filter(value => value !== null); // Entferne den null-Platzhalter für Zeitstempel

        // Bereich zum Schreiben definieren (z.B. A<rowNum>:H<rowNum>)
        const range = `${SHEET_NAME}!A${rowNum}:${UPDATE_COLUMN_END_LETTER}${rowNum}`;
        console.log(`Aktualisiere Bereich: ${range}`);

        const response = await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
            valueInputOption: 'USER_ENTERED', // oder 'RAW'
            resource: {
                values: [valuesToWrite] // Muss ein Array von Zeilen sein
            }
        });

        console.log(`Zeile ${rowNum} erfolgreich aktualisiert:`, response.data);
        res.json({ success: true, message: "Event erfolgreich aktualisiert." });

    } catch (error) {
        console.error(`Fehler in PUT /api/events/${rowNum}:`, error.message);
        console.error("Stack:", error.stack);
        let clientMessage = "Fehler beim Aktualisieren des Events.";
        if (error.response?.data?.error) {
            clientMessage += ` Details: ${error.response.data.error.message || error.message}`;
        } else { clientMessage += ` Details: ${error.message}`; }
        res.status(500).json({ success: false, message: clientMessage });
    }
});

// POST /api/auth/check - Überprüft das Passwort
app.post('/api/auth/check', (req, res) => {
    console.log('API POST /api/auth/check aufgerufen');
    const { password: userPassword } = req.body;

    if (!APP_PASSWORD) {
        console.error("SICHERHEITSWARNUNG: Kein APP_PASSWORD in Umgebungsvariablen gefunden! Passwortprüfung nicht möglich.");
        // Sende keinen spezifischen Fehler an den Client, der das Fehlen des Passworts verrät
        return res.status(500).json({ error: 'Server-Konfigurationsfehler.' });
    }
    if (typeof userPassword !== 'string') {
        return res.status(400).json({ error: 'Passwort fehlt oder ungültiges Format im Request Body.' });
    }

    // Einfacher String-Vergleich (Timing-Angriffe sind hier weniger relevant als bei Hash-Vergleichen)
    const isValid = (userPassword === APP_PASSWORD);
    console.log(`Passwortprüfung: ${isValid ? 'Erfolgreich' : 'Fehlgeschlagen'}`);

    // Sende nur zurück, ob gültig oder nicht
    res.json({ isValid: isValid });
});


// --- Hauptroute und Serverstart ---

// "*" Route fängt alle übrigen GET-Requests ab und sendet index.html (für Frontend-Routing)
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    if (!SPREADSHEET_ID || SPREADSHEET_ID === '1v213UqdChUATSQoTeOl_poaZj17MbXRAjk8nJXKzyXQ') {
        console.warn('WARNUNG: Umgebungsvariable SPREADSHEET_ID ist nicht gesetzt oder verwendet Beispiel-ID.');
    }
    if (!APP_PASSWORD) {
        console.warn('WARNUNG: Umgebungsvariable APP_PASSWORD ist nicht gesetzt. Passwortprüfung wird fehlschlagen.');
        console.warn('WARNUNG: Für Produktion dringend empfohlen, Secret Manager für Passwörter zu verwenden!');
    }
});

// DELETE /api/events/:rowNum - Löscht ein Event
app.delete('/api/events/:rowNum', async (req, res) => {
    const rowNum = parseInt(req.params.rowNum, 10);
    console.log(`API DELETE /api/events/${rowNum} aufgerufen`);

    if (!SPREADSHEET_ID) return res.status(500).json({ error: 'Serverkonfiguration: Spreadsheet ID fehlt.' });
    if (isNaN(rowNum) || rowNum <= HEADER_ROW) { // Zeilennummer muss gültig sein
        return res.status(400).json({ error: 'Ungültige Zeilennummer zum Löschen angegeben.' });
    }

    try {
        const sheets = await getAuthenticatedSheetsClient(false); // Schreibzugriff benötigt

        // Schritt 1: Metadaten abrufen, um die numerische sheetId für den Tabellennamen zu finden
        console.log(`Rufe Metadaten ab für Sheet ID: <span class="math-inline">\{SPREADSHEET\_ID\} um Sheet ID für "</span>{SHEET_NAME}" zu finden.`);
        const metadata = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            fields: 'sheets(properties(sheetId,title))' // Nur benötigte Felder abrufen
        });

        const sheet = metadata.data.sheets.find(s => s.properties.title === SHEET_NAME);

        if (!sheet || sheet.properties.sheetId === undefined) {
            console.error(`Tabellenblatt "${SHEET_NAME}" nicht in Metadaten gefunden oder hat keine sheetId.`);
            return res.status(404).json({ error: `Tabellenblatt "${SHEET_NAME}" nicht gefunden.` });
        }
        const sheetId = sheet.properties.sheetId;
        console.log(`Sheet ID für "${SHEET_NAME}" ist: ${sheetId}`);

        // Schritt 2: Den BatchUpdate Request zum Löschen der Zeile erstellen
        const deleteRequest = {
            deleteDimension: {
                range: {
                    sheetId: sheetId,       // Numerische ID des Tabs
                    dimension: "ROWS",      // Wir wollen eine Zeile löschen
                    startIndex: rowNum - 1, // API ist 0-basiert, also Zeilennummer - 1
                    endIndex: rowNum        // Der Endindex ist exklusiv ([startIndex, endIndex))
                }
            }
        };

        console.log(`Sende BatchUpdate zum Löschen von Zeile ${rowNum} (Index ${rowNum - 1}) auf Sheet ID ${sheetId}`);
        const batchUpdateResponse = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                requests: [deleteRequest]
            }
        });

        console.log(`Zeile ${rowNum} erfolgreich gelöscht:`, batchUpdateResponse.data);
        res.json({ success: true, message: 'Event erfolgreich gelöscht.' });

    } catch (error) {
        console.error(`Fehler in DELETE /api/events/${rowNum}:`, error.message);
        if (error.response?.data?.error) { // Detailliertere Google API Fehler anzeigen
             console.error("Google API Error Details:", JSON.stringify(error.response.data.error, null, 2));
        } else {
             console.error("Stack:", error.stack);
        }
        let clientMessage = "Fehler beim Löschen des Events.";
        if (error.response?.data?.error) {
            clientMessage += ` Details: ${error.response.data.error.message || error.message}`;
        } else { clientMessage += ` Details: ${error.message}`; }
        res.status(500).json({ success: false, message: clientMessage });
    }
});