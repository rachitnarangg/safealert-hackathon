require('dotenv').config(); // Load .env file first — before any other code

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const multer = require('multer');

// Setup multer storage
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true })); // For Twilio webhooks
app.use(express.static(__dirname)); // Serve HTML files in the same directory
app.use('/uploads', express.static(uploadDir)); // Serve uploaded media

// Root route → redirect to admin setup page
app.get('/', (req, res) => {
  res.redirect('/admin-setup.html');
});

const JWT_SECRET = process.env.JWT_SECRET || 'safealert-dev-secret-change-in-production';
const PORT = process.env.PORT || 3000;
let db;

let globalEmergencyActive = false;
let globalEmergencyStartTime = null;

async function initDB() {
  db = await open({ filename: 'database.sqlite', driver: sqlite3.Database });

  // Config Table (Store hotel details as JSON)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY,
      data TEXT
    )
  `);

  // Staff Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT
    )
  `);

  // Incidents Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      type TEXT,
      room TEXT,
      floor TEXT,
      severity TEXT,
      status TEXT,
      escalated INTEGER,
      time TEXT,
      resolvedAt TEXT,
      media TEXT,
      children TEXT,
      lat REAL,
      lng REAL
    )
  `);
  try { await db.exec(`ALTER TABLE incidents ADD COLUMN children TEXT`); } catch (e) { }
  try { await db.exec(`ALTER TABLE incidents ADD COLUMN lat REAL`); } catch (e) { }
  try { await db.exec(`ALTER TABLE incidents ADD COLUMN lng REAL`); } catch (e) { }

  // Initialize empty config if not exists
  const conf = await db.get('SELECT * FROM config WHERE id = 1');
  if (!conf) {
    await db.run('INSERT INTO config (id, data) VALUES (1, ?)', ['{}']);
    // Default admin
    const hashed = await bcrypt.hash('admin123', 10);
    await db.run('INSERT INTO staff (name, username, password, role) VALUES (?, ?, ?, ?)', ['Admin', 'admin', hashed, 'admin']);
  }

  console.log('Database initialized');
}

// === MIDDLEWARE ===
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
}

// === API ROUTES ===

// --- Config ---
app.get('/api/config', async (req, res) => {
  const row = await db.get('SELECT data FROM config WHERE id = 1');
  res.json(JSON.parse(row.data));
});

app.post('/api/config', async (req, res) => {
  const configData = req.body;
  await db.run('UPDATE config SET data = ? WHERE id = 1', [JSON.stringify(configData)]);

  // Update Staff members
  if (configData.staffCredentials) {
    await db.run('DELETE FROM staff');
    for (const staff of configData.staffCredentials) {
      const hashed = await bcrypt.hash(staff.password, 10);
      await db.run('INSERT INTO staff (name, username, password, role) VALUES (?, ?, ?, ?)',
        [staff.name, staff.username, hashed, staff.role || 'staff']);
    }
  }

  res.json({ success: true });
});

// --- Auth ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.get('SELECT * FROM staff WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, JWT_SECRET);
  res.json({ token, name: user.name });
});

// --- AI Alert Buffer ---
let alertBuffer = [];
let processingBuffer = false;
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const hotelGraph = {
  "Room 401": { x: 50, y: 70, edges: ["Corridor West"] },
  "Room 412": { x: 115, y: 70, edges: ["Corridor Mid1"] },
  "Room 413": { x: 180, y: 70, edges: ["Corridor Mid2"] },
  "Room 414": { x: 245, y: 70, edges: ["Corridor East"] },
  "Room 421": { x: 50, y: 180, edges: ["Corridor West"] },
  "Room 422": { x: 115, y: 180, edges: ["Corridor Mid1"] },
  "Room 423": { x: 180, y: 180, edges: ["Corridor Mid2"] },
  "Corridor West": { x: 50, y: 127, edges: ["Room 401", "Room 421", "Corridor Mid1"] },
  "Corridor Mid1": { x: 115, y: 127, edges: ["Room 412", "Room 422", "Corridor West", "Corridor Mid2"] },
  "Corridor Mid2": { x: 180, y: 127, edges: ["Room 413", "Room 423", "Corridor Mid1", "Corridor East"] },
  "Corridor East": { x: 270, y: 127, edges: ["Room 414", "Corridor Mid2", "Exit Stair B"] },
  "Exit Stair B": { x: 280, y: 55, edges: ["Corridor East"] }
};

function dijkstra(startNode, endNode, dangerZones) {
  let distances = {};
  let prev = {};
  let pq = new Set(Object.keys(hotelGraph));
  
  for (let node of pq) distances[node] = Infinity;
  distances[startNode] = 0;
  
  while (pq.size > 0) {
    let minNode = null;
    for (let node of pq) {
      if (minNode === null || distances[node] < distances[minNode]) minNode = node;
    }
    if (distances[minNode] === Infinity) break;
    if (minNode === endNode) break;
    pq.delete(minNode);
    
    for (let neighbor of hotelGraph[minNode].edges) {
      // Danger zones have infinite cost
      let weight = dangerZones.includes(neighbor) ? Infinity : 1;
      let alt = distances[minNode] + weight;
      if (alt < distances[neighbor]) {
        distances[neighbor] = alt;
        prev[neighbor] = minNode;
      }
    }
  }
  
  let path = [];
  let u = endNode;
  if (prev[u] !== undefined || u === startNode) {
    while (u) {
      path.unshift(u);
      u = prev[u];
    }
  }
  return path;
}

const connectedGuests = {}; // socket.id -> { room, cprTrained }

function triggerGoodSamaritan(incident) {
  if (incident.type !== 'medical') return;
  const victimNode = incident.room;
  const victimData = hotelGraph[victimNode];
  
  for (const [sid, guest] of Object.entries(connectedGuests)) {
    if (guest.cprTrained && guest.room !== incident.room) {
      let isNearby = true; // Fallback
      if (victimData && hotelGraph[guest.room]) {
        const guestData = hotelGraph[guest.room];
        const dist = Math.sqrt(Math.pow(victimData.x - guestData.x, 2) + Math.pow(victimData.y - guestData.y, 2));
        if (dist > 150) isNearby = false;
      }
      if (isNearby) {
        io.to(sid).emit('good_samaritan_alert', { room: incident.room, id: incident.id });
      }
    }
  }
}

async function saveAndEmitIncident(inc) {
  const mediaStr = JSON.stringify(inc.media || []);
  const childrenStr = JSON.stringify(inc.children || []);
  await db.run(`
    INSERT INTO incidents (id, type, room, floor, severity, status, escalated, time, resolvedAt, media, children, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [inc.id, inc.type, inc.room, inc.floor, inc.severity, inc.status, inc.escalated ? 1 : 0, inc.time, null, mediaStr, childrenStr, inc.lat || null, inc.lng || null]);
  io.emit('new_alert', inc);
  triggerGoodSamaritan(inc);
}

async function processAlertBuffer() {
  if (alertBuffer.length === 0 || processingBuffer) return;
  processingBuffer = true;

  const batch = [...alertBuffer];
  alertBuffer = []; // Clear for next batch

  // If only 1 alert or no API key, bypass grouping to save time
  if (batch.length === 1 || !process.env.GEMINI_API_KEY) {
    for (const inc of batch) {
      await saveAndEmitIncident(inc);
    }
    processingBuffer = false;
    return;
  }

  try {
    const prompt = `You are an emergency triage AI. I will provide a JSON array of incoming SOS alerts.
Your task is to identify patterns and deduplicate or group them into parent alerts, AND identify "Danger Zones" to avoid during evacuation.
Available Nodes in Map: Room 401, Room 412, Room 413, Room 414, Room 421, Room 422, Room 423, Corridor West, Corridor Mid1, Corridor Mid2, Corridor East, Exit Stair B.
Mark the emergency rooms and directly adjacent corridors as danger zones.

Return ONLY a valid JSON object following this structure:
{
  "groupedAlerts": [
    {
      "id": "cluster_" + <random string>,
      "type": "<the type, e.g. 'fire'>",
      "room": "<'Multiple Rooms' or specific room>",
      "floor": "<the floor, e.g., 'Floor 4'>",
      "severity": "<'high' or 'critical'>",
      "status": "active",
      "escalated": false,
      "time": "<current time>",
      "children": [ <array of the exact individual alert objects that were grouped> ],
      "media": []
    }
  ],
  "dangerZones": [ "<Node 1>", "<Node 2>" ]
}
Input alerts: ${JSON.stringify(batch)}
ONLY OUTPUT VALID JSON.`;

    const model = ai.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    
    let text = result.response.text().replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    const parsed = JSON.parse(text);
    
    for (const parent of parsed.groupedAlerts) {
      await saveAndEmitIncident(parent);
    }
    
    // Broadcast dynamic evacuation route for Floor 4
    // We assume the user triggering SOS is in one of the rooms.
    // For demo, we broadcast the generic danger zones and let the frontend request specific paths,
    // or we calculate safe routes for all nodes and emit them.
    const dangerZones = parsed.dangerZones || [];
    io.emit('evacuation_danger_zones', { dangerZones });
    
  } catch (e) {
    console.error("Gemini API Error:", e);
    // Fallback: send individually
    for (const inc of batch) {
      await saveAndEmitIncident(inc);
    }
  }

  processingBuffer = false;
}

setInterval(processAlertBuffer, 5000);

// --- Routing ---
function getNearestNode(lat, lng) {
  // Demo mock bounds for hackathon
  const MIN_LAT = 34.0500, MAX_LAT = 34.0510;
  const MIN_LNG = -118.2500, MAX_LNG = -118.2490;
  
  // Map to 340x260 coordinate space of the graph
  let x = ((lng - MIN_LNG) / (MAX_LNG - MIN_LNG)) * 340;
  let y = ((MAX_LAT - lat) / (MAX_LAT - MIN_LAT)) * 260;

  if (isNaN(x) || isNaN(y)) return "Room 412";

  let closestNode = null;
  let minDistance = Infinity;

  for (const [nodeName, data] of Object.entries(hotelGraph)) {
    const dist = Math.sqrt(Math.pow(data.x - x, 2) + Math.pow(data.y - y, 2));
    if (dist < minDistance) {
      minDistance = dist;
      closestNode = nodeName;
    }
  }
  return closestNode || "Room 412";
}

app.post('/api/route', (req, res) => {
  const { startLat, startLng, startRoom, dangerZones } = req.body;
  
  let node = startRoom;
  if (startLat && startLng) {
    node = getNearestNode(startLat, startLng);
  } else if (!node) {
    node = "Room 412"; // Fallback
  }

  const path = dijkstra(node, "Exit Stair B", dangerZones || []);
  
  if (path.length === 0 || path.includes(undefined)) {
    return res.json({ success: false, path: [] });
  }
  
  const coords = path.map(n => ({ node: n, x: hotelGraph[n].x, y: hotelGraph[n].y }));
  res.json({ success: true, path: coords });
});

// --- Twilio SMS Fallback ---
app.post('/api/sms-webhook', async (req, res) => {
  const { Body, From } = req.body;
  const twilio = require('twilio');
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    // The mobile client formats the SOS as a JSON string and opens the native SMS app
    const inc = JSON.parse(Body.trim());
    inc.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Inject directly into the AI alert buffer, treating it exactly like a web alert!
    alertBuffer.push(inc);
    
    twiml.message('SafeAlert Offline SOS Received. Help is on the way.');
    res.type('text/xml').send(twiml.toString());
  } catch (e) {
    console.error("SMS Parsing Error:", e);
    twiml.message('Emergency received, but format was unclear. Staff notified.');
    res.type('text/xml').send(twiml.toString());
  }
});

// --- AI Map Analysis ---
app.post('/api/analyze-map', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image provided' });

  try {
    const base64Str = imageData.replace(/^data:image\/\w+;base64,/, "");
    
    const model = ai.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const prompt = `You are an expert architectural blueprint and CAD analyzer. 
Analyze the provided hotel floor plan image comprehensively.
1. Identify EVERY single guest room. 
2. IF rooms are indicated as a block or range (e.g., "ROOM 201-208"), you MUST individually list EACH room in that sequence (e.g., Room 201, Room 202, Room 203, Room 204, Room 205, Room 206, Room 207, Room 208). Do not output the range itself.
3. Identify all critical infrastructure: stairwells, elevators, fire exits, and emergency exits.
4. Assign the correct floor name (e.g., "Ground Floor", "First Floor") based on the section labels in the blueprint.

Output STRICTLY as a JSON object with this structure:
{
  "rooms": [
    { "name": "Room 101", "floor": "Ground Floor" },
    { "name": "Room 102", "floor": "Ground Floor" }
  ],
  "infrastructure": [
    { "name": "Exit A", "type": "Exit" },
    { "name": "Main Staircase", "type": "Stairs" },
    { "name": "ADA Elevator", "type": "Elevator" }
  ]
}
DO NOT include any markdown formatting or \`\`\`json blocks. Return ONLY the raw JSON object.`;

    const imagePart = {
      inlineData: {
        data: base64Str,
        mimeType: imageData.match(/^data:(image\/\w+);base64,/)?.[1] || "image/jpeg"
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();
    
    let data;
    try {
      // First attempt: clean any markdown
      let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      data = JSON.parse(cleanText);
    } catch (parseError) {
      console.warn("Standard JSON parse failed, attempting regex extraction...");
      // Fallback: extract substring between first { and last }
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Could not extract JSON: " + responseText);
      }
    }

    res.json({ success: true, data });
  } catch (e) {
    console.error("\n--- AI Map Analysis Error ---");
    console.error(e.message || e);
    res.status(500).json({ success: false, error: e.message || 'Failed to analyze map.' });
  }
});

// --- Incidents ---
app.post('/api/evac-instructions', async (req, res) => {
  const { guest_location, fire_source } = req.body;
  if (!guest_location || !fire_source) return res.json({ instruction: "Evacuate immediately via the nearest safe exit." });
  
  try {
    const prompt = `You are a real-time dynamic evacuation AI for a hotel. 
A hazard has been detected at ${fire_source}. The guest is located at ${guest_location}.
Based on typical hotel layouts and logic, give a short, direct, custom escape instruction in 1-2 sentences. 
Tell them exactly where to go based on the fire source, e.g. "Turn left out of your door, the right hallway is blocked."
Return ONLY the instruction text.`;
    const model = ai.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    let instruction = result.response.text().trim();
    res.json({ instruction });
  } catch (e) {
    console.error("Gemini Evac Error:", e);
    res.json({ instruction: `HAZARD DETECTED at ${fire_source}. Avoid this area and exit via the nearest safe staircase.` });
  }
});

app.get('/api/incidents', async (req, res) => {
  const rows = await db.all('SELECT * FROM incidents ORDER BY rowid DESC');
  const incidents = rows.map(r => ({
    ...r,
    escalated: !!r.escalated,
    media: JSON.parse(r.media || '[]'),
    children: JSON.parse(r.children || '[]')
  }));
  res.json(incidents);
});

app.post('/api/incidents', async (req, res) => {
  alertBuffer.push(req.body);
  res.json({ success: true, message: 'Alert queued for AI triage' });
});

app.post('/api/incidents/:id/media', async (req, res) => {
  const { id } = req.params;
  const newMedia = req.body;

  const row = await db.get('SELECT media FROM incidents WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'Incident not found' });

  const mediaArr = JSON.parse(row.media || '[]');
  mediaArr.push(newMedia);

  await db.run('UPDATE incidents SET media = ? WHERE id = ?', [JSON.stringify(mediaArr), id]);

  io.emit('incident_updated', { id, media: mediaArr });
  res.json({ success: true });
});

app.post('/api/upload-media', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ success: true, url });
});

app.post('/api/incidents/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const resolvedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  await db.run('UPDATE incidents SET status = ?, resolvedAt = ? WHERE id = ?', ['resolved', resolvedAt, id]);

  io.emit('incident_resolved', { id, resolvedAt });
  res.json({ success: true });
});

app.post('/api/incidents/:id/escalate', async (req, res) => {
  const { id } = req.params;
  await db.run('UPDATE incidents SET severity = ?, escalated = 1 WHERE id = ?', ['critical', id]);
  io.emit('incident_escalated', { id });
  res.json({ success: true });
});

// --- NEW LOGIC: Welfare & Broadcast ---
app.post('/api/emergency/broadcast', (req, res) => {
  globalEmergencyActive = true;
  globalEmergencyStartTime = Date.now();
  io.emit('global_emergency_broadcast', { active: true, startTime: globalEmergencyStartTime });
  res.json({ success: true });
});

app.post('/api/incidents/:id/welfare', async (req, res) => {
  const { id } = req.params;
  const { status, lat, lng } = req.body; 
  if (lat && lng) {
    await db.run('UPDATE incidents SET status = ?, lat = ?, lng = ? WHERE id = ?', [status, lat, lng, id]);
  } else {
    await db.run('UPDATE incidents SET status = ? WHERE id = ?', [status, id]);
  }
  io.emit('incident_welfare_updated', { id, status, lat, lng });
  res.json({ success: true });
});

app.post('/api/welfare-response', async (req, res) => {
  const { id, status, lat, lng, room } = req.body;
  let incident = id ? await db.get('SELECT * FROM incidents WHERE id = ?', [id]) : null;

  if (incident) {
    if (lat && lng) {
      await db.run('UPDATE incidents SET status = ?, lat = ?, lng = ? WHERE id = ?', [status, lat, lng, id]);
    } else {
      await db.run('UPDATE incidents SET status = ? WHERE id = ?', [status, id]);
    }
    io.emit('incident_welfare_updated', { id, status, lat, lng });
    res.json({ success: true, id });
  } else {
    const newId = 'WLF-' + Math.floor(Math.random()*10000);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await db.run(`INSERT INTO incidents (id, type, room, floor, severity, status, time, lat, lng)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, 'Welfare Check', room || 'Unknown', 'Unknown', 'high', status, time, lat, lng]
    );
    const newAlert = {
      id: newId, type: 'Welfare Check', room: room || 'Unknown', floor: 'Unknown',
      severity: 'high', status, time, lat, lng, media: [], children: []
    };
    io.emit('new_alert', newAlert);
    res.json({ success: true, id: newId });
  }
});

app.post('/api/twilio/simulate-welfare-sms', (req, res) => {
  const { phone, room } = req.body;
  console.log(`\n[TWILIO API SIMULATION] 🚨 EMERGENCY SMS SENT TO: ${phone} (Room ${room})`);
  console.log(`MESSAGE: "EMERGENCY: Building Evacuation. Confirm safety at http://localhost:${PORT}/crisis-portal.html or reply SAFE."\n`);
  res.json({ success: true, message: 'SMS Sent via Twilio API' });
});

app.get('/api/ip', (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIp = 'localhost';

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
  }
  res.json({ ip: localIp });
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('update_location', async (data) => {
    // data = { id, lat, lng }
    // Optionally update DB
    await db.run('UPDATE incidents SET lat = ?, lng = ? WHERE id = ?', 
      [data.lat, data.lng, data.id]);
    
    // Broadcast immediately to the staff dashboard
    io.emit('location_updated', data);
  });

  // Guest to Staff
  socket.on('chat_message', async (data) => {
    // data = { id, type, content, time, sender: 'guest' }
    const row = await db.get('SELECT media FROM incidents WHERE id = ?', [data.id]);
    if (row) {
      const mediaArr = JSON.parse(row.media || '[]');
      mediaArr.push(data);
      await db.run('UPDATE incidents SET media = ? WHERE id = ?', [JSON.stringify(mediaArr), data.id]);
      io.emit('incident_updated', { id: data.id, media: mediaArr });
    }
  });

  // Staff to Guest
  socket.on('staff_reply', async (data) => {
    // data = { id, type: 'text', content, time, sender: 'staff' }
    const row = await db.get('SELECT media FROM incidents WHERE id = ?', [data.id]);
    if (row) {
      const mediaArr = JSON.parse(row.media || '[]');
      mediaArr.push(data);
      await db.run('UPDATE incidents SET media = ? WHERE id = ?', [JSON.stringify(mediaArr), data.id]);
      io.emit('incident_updated', { id: data.id, media: mediaArr });
      io.emit('staff_reply', data); // Explicitly send to guest
    }
  });

  socket.on('register_guest', (data) => {
    connectedGuests[socket.id] = data;
  });

  socket.on('disconnect', () => {
    delete connectedGuests[socket.id];
    console.log('Client disconnected:', socket.id);
  });
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`SafeAlert Backend running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
});
