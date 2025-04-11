# Basierend auf einem offiziellen Node.js Image (wähle eine passende Version)
FROM node:18-alpine

# Arbeitsverzeichnis im Container erstellen
WORKDIR /usr/src/app

# Abhängigkeiten installieren
# Kopiere package.json und package-lock.json (oder yarn.lock)
COPY package*.json ./
# Installiere nur Produktionsabhängigkeiten
RUN npm ci --only=production

# Kopiere den Rest des Anwendungs-Codes in das Arbeitsverzeichnis
COPY . .

# Gib den Port an, auf dem die App im Container lauscht (muss mit dem in server.js übereinstimmen)
EXPOSE 8080

# Befehl zum Starten der Anwendung, wenn der Container startet
CMD [ "node", "src/server.js" ]