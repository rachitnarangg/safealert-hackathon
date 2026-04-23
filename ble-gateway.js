const noble = require('@abandonware/noble');
const http = require('http');

// SafeAlert BLE Advertising UUID used by the mobile app to signal offline SOS
const SAFEALERT_BLE_UUID = '12345678-1234-5678-1234-56789abcdef0';

console.log('Starting SafeAlert BLE Peripheral Gateway...');

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    console.log('Bluetooth adapter is powered on. Listening for offline SOS broadcasts...');
    // Scan for any devices advertising the SafeAlert UUID
    await noble.startScanningAsync([SAFEALERT_BLE_UUID], true);
  } else {
    console.log(`Bluetooth adapter state changed to: ${state}. Stopping scan.`);
    noble.stopScanning();
  }
});

noble.on('discover', async (peripheral) => {
  console.log(`\n[BLE OFFLINE FALLBACK] Detected SafeAlert signal from device: ${peripheral.address}`);
  
  // The mobile app should encode the SOS JSON payload directly into the manufacturerData 
  // or a custom characteristic. For this hackathon prototype, we extract the manufacturerData.
  const mfgData = peripheral.advertisement.manufacturerData;
  
  if (mfgData) {
    try {
      // Parse the JSON payload from the BLE broadcast
      const payloadString = mfgData.toString('utf8');
      const alertPayload = JSON.parse(payloadString);
      
      console.log('Successfully extracted offline SOS payload:', alertPayload);
      
      // Inject the alert directly into the main SafeAlert Backend
      // This routes the offline alert through the AI Buffer and WebSockets exactly like a web alert!
      const postData = JSON.stringify(alertPayload);
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/incidents',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        console.log(`[BLE OFFLINE FALLBACK] Alert injected to main server. Status: ${res.statusCode}`);
      });
      
      req.on('error', (e) => {
        console.error('[BLE OFFLINE FALLBACK] Error connecting to main server:', e.message);
      });
      
      req.write(postData);
      req.end();
      
    } catch (e) {
      console.error('Failed to parse SOS payload from BLE device:', e);
    }
  }
});

/*
 * ==============================================================================
 * INSTRUCTIONS FOR MOBILE APP DEVELOPERS (React Native / Capacitor / Swift)
 * ==============================================================================
 * 
 * When the guest's mobile phone detects that there is NO WiFi and NO Cellular data:
 * 
 * 1. The mobile app should initialize its Bluetooth hardware as a "Peripheral" (Broadcaster).
 * 2. Start advertising using the service UUID: '12345678-1234-5678-1234-56789abcdef0'.
 * 3. Embed the JSON SOS payload into the `manufacturerData` of the BLE advertisement.
 * 
 * Example Payload:
 * {
 *   "id": "alert_ble_99",
 *   "type": "fire",
 *   "room": "Room 412",
 *   "floor": "Floor 4",
 *   "severity": "high",
 *   "status": "active"
 * }
 * 
 * This BLE gateway runs on a Raspberry Pi or Intel NUC hidden in the hotel hallways. 
 * When it detects the broadcast, it bridges the gap and pushes the alert to the local 
 * hotel intranet!
 */
