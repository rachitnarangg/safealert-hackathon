# ============================================================
# SafeAlert BLE Edge Gateway
# ============================================================
# This script runs on a Raspberry Pi (or any device with Bluetooth).
# It scans for BLE advertisements from guest phones when they are OFFLINE
# (no WiFi, no cellular), then forwards the SOS payload to the main
# SafeAlert cloud server via HTTP POST.
#
# HOW TO RUN ON RASPBERRY PI:
#   1. Copy this file + package.json to the Pi
#   2. npm install @abandonware/noble node-fetch dotenv
#   3. Create a .env file with CLOUD_API_URL=https://your-server.com
#   4. sudo node ble-edge-gateway.js
# ============================================================

require('dotenv').config();
const noble = require('@abandonware/noble');

// Use node-fetch for HTTP requests (works on all Node versions)
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// The main SafeAlert server URL - set this in .env on the Raspberry Pi
const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:3000';

// SafeAlert BLE Advertising UUID used by the mobile app to signal offline SOS
const SAFEALERT_BLE_UUID = '12345678-1234-5678-1234-56789abcdef0';

// Deduplicate alerts - don't re-send the same alert from the same device twice in 30 seconds
const recentAlerts = new Map();
const DEDUP_WINDOW_MS = 30_000;

console.log('╔══════════════════════════════════════════════╗');
console.log('║  SafeAlert BLE Edge Gateway — Starting Up   ║');
console.log('╚══════════════════════════════════════════════╝');
console.log(`Forwarding SOS alerts to: ${CLOUD_API_URL}`);

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    console.log('[BLE] Bluetooth powered on. Scanning for offline SOS broadcasts...');
    await noble.startScanningAsync([SAFEALERT_BLE_UUID], true /* allow duplicates */);
  } else {
    console.warn(`[BLE] Adapter state: ${state}. Stopping scan.`);
    noble.stopScanning();
  }
});

noble.on('discover', async (peripheral) => {
  const deviceAddr = peripheral.address;
  const mfgData = peripheral.advertisement.manufacturerData;

  if (!mfgData) return;

  // Deduplicate: skip if we already forwarded an alert from this device recently
  const lastSent = recentAlerts.get(deviceAddr);
  if (lastSent && (Date.now() - lastSent) < DEDUP_WINDOW_MS) return;

  try {
    const payloadString = mfgData.toString('utf8');
    const alertPayload = JSON.parse(payloadString);

    console.log(`\n[BLE] 📡 Offline SOS detected from device: ${deviceAddr}`);
    console.log('[BLE] Payload:', alertPayload);

    // Mark as seen immediately to prevent duplicates
    recentAlerts.set(deviceAddr, Date.now());

    // Forward to the main SafeAlert server
    const response = await fetch(`${CLOUD_API_URL}/api/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...alertPayload,
        source: 'ble-gateway',    // Tag it so staff can see it came offline
        gatewayDevice: deviceAddr,
      }),
    });

    if (response.ok) {
      console.log(`[BLE] ✅ Alert forwarded successfully. Server status: ${response.status}`);
    } else {
      console.error(`[BLE] ❌ Server rejected alert. Status: ${response.status}`);
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error('[BLE] Could not parse BLE advertisement as JSON. Skipping.');
    } else {
      console.error('[BLE] Error forwarding alert to server:', e.message);
    }
  }
});

// ============================================================
// INSTRUCTIONS FOR MOBILE APP DEVELOPERS
// ============================================================
// When the guest phone has NO WiFi + NO Cellular:
//   1. App initializes Bluetooth as a "Peripheral" (Broadcaster).
//   2. Advertise with service UUID: '12345678-1234-5678-1234-56789abcdef0'
//   3. Embed the SOS JSON payload inside the BLE 'manufacturerData'.
//
// Example Payload:
// {
//   "id": "alert_ble_99",
//   "type": "fire",
//   "room": "Room 412 (BLE Fallback)",
//   "floor": "Floor 4",
//   "lat": 34.05012,
//   "lng": -118.24955,
//   "severity": "high",
//   "status": "active"
// }
//
// This gateway runs on a Raspberry Pi hidden in hotel hallways.
// It bridges offline phones → hotel intranet → cloud server.
// ============================================================
