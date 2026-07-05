const http = require('node:http');
const https = require('node:https');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) return;

  const lines = fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const SPREADSHEET_PATH = path.join(ROOT, 'customer-requests.csv');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'quote-uploads';
const SUPABASE_REQUESTS_TABLE = process.env.SUPABASE_REQUESTS_TABLE || 'quote_requests';
const SAVE_LOCAL_COPY = process.env.SAVE_LOCAL_COPY === 'true' || (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY);
const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';
const TWILIO_WHATSAPP_TO = process.env.TWILIO_WHATSAPP_TO || '';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SPREADSHEET_COLUMNS = [
  'receivedAt',
  'customerName',
  'customerEmail',
  'customerPhone',
  'shippingAddress',
  'shippingCity',
  'shippingPincode',
  'customerNotes',
  'originalFilename',
  'savedFilename',
  'material',
  'price',
  'weight',
  'volume',
  'printTime',
  'leadTime',
  'uploadPath',
  'requestId'
];
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function safeName(name) {
  return path.basename(name || 'uploaded-file').replace(/[^a-z0-9._-]/gi, '_');
}

function csvValue(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed with ${response.status}: ${body}`);
  }

  return response;
}

async function uploadFileToSupabase(filePart, requestId, filename) {
  const uploadPath = `${requestId}/${filename}`;
  const encodedPath = uploadPath.split('/').map(encodeURIComponent).join('/');

  await supabaseRequest(`/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${encodedPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'false'
    },
    body: filePart.content
  });

  return uploadPath;
}

function toSupabaseRow(details) {
  return {
    request_id: details.requestId,
    received_at: details.receivedAt,
    customer_name: details.customerName || '',
    customer_email: details.customerEmail || '',
    customer_phone: details.customerPhone || '',
    shipping_address: details.shippingAddress || '',
    shipping_city: details.shippingCity || '',
    shipping_pincode: details.shippingPincode || '',
    customer_notes: details.customerNotes || '',
    original_filename: details.originalFilename || '',
    saved_filename: details.savedFilename || '',
    upload_path: details.uploadPath || '',
    material: details.material || '',
    price: details.price || '',
    weight: details.weight || '',
    volume: details.volume || '',
    print_time: details.printTime || '',
    lead_time: details.leadTime || ''
  };
}

async function insertRequestIntoSupabase(details) {
  await supabaseRequest(`/rest/v1/${encodeURIComponent(SUPABASE_REQUESTS_TABLE)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(toSupabaseRow(details))
  });
}

async function appendSpreadsheetRow(details) {
  const header = SPREADSHEET_COLUMNS.map(csvValue).join(',') + '\r\n';
  const row = SPREADSHEET_COLUMNS.map(column => csvValue(details[column])).join(',') + '\r\n';

  try {
    await fs.access(SPREADSHEET_PATH);
  } catch {
    await fs.writeFile(SPREADSHEET_PATH, '\ufeff' + header);
  }

  await fs.appendFile(SPREADSHEET_PATH, row);
}

function buildGoogleSheetsPayload(details) {
  return JSON.stringify(Object.fromEntries(SPREADSHEET_COLUMNS.map(column => [column, details[column] ?? ''])));
}

function forwardToGoogleSheets(details) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) {
    return Promise.resolve();
  }

  const payload = buildGoogleSheetsPayload(details);
  const url = new URL(GOOGLE_SHEETS_WEBHOOK_URL);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let responseBody = '';
        res.on('data', chunk => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(new Error(`Google Sheets request failed with ${res.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendWhatsAppNotification(details, requestId) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !TWILIO_WHATSAPP_TO) {
    return Promise.resolve();
  }

  const message = `New quote request received!\nRequest ID: ${requestId}\nCustomer: ${details.customerName || 'Unknown'}\nEmail: ${details.customerEmail || 'N/A'}\nFile: ${details.originalFilename || 'Unknown'}\nMaterial: ${details.material || 'N/A'}`;
  const body = new URLSearchParams({
    From: TWILIO_WHATSAPP_FROM,
    To: TWILIO_WHATSAPP_TO,
    Body: message
  });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const options = {
    protocol: 'https:',
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body.toString())
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => {
        responseBody += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseBody);
        } else {
          reject(new Error(`WhatsApp notification failed with ${res.statusCode}: ${responseBody}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body.toString());
    req.end();
  });
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    if (body.slice(partStart, partStart + 2).toString() === '--') break;
    if (body.slice(partStart, partStart + 2).toString() === '\r\n') partStart += 2;

    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;

    let part = body.slice(partStart, next);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const rawHeaders = part.slice(0, headerEnd).toString('latin1');
      const content = part.slice(headerEnd + 4);
      const disposition = rawHeaders.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const name = disposition.match(/name="([^"]+)"/)?.[1];
      const filename = disposition.match(/filename="([^"]*)"/)?.[1];

      if (name) parts.push({ name, filename, content });
    }

    cursor = next;
  }

  return parts;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error('Upload too large');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function handleQuoteRequest(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    send(res, 400, JSON.stringify({ error: 'Missing multipart boundary' }), 'application/json');
    return;
  }

  const body = await readBody(req);
  const parts = parseMultipart(body, boundary);
  const filePart = parts.find(part => part.name === 'file' && part.filename);

  if (!filePart || filePart.content.length === 0) {
    send(res, 400, JSON.stringify({ error: 'No file uploaded' }), 'application/json');
    return;
  }

  const requestId = new Date().toISOString().replace(/[:.]/g, '-');
  const requestDir = path.join(UPLOAD_DIR, requestId);
  const filename = safeName(filePart.filename);
  const details = {};

  for (const part of parts) {
    if (part.name !== 'file') {
      details[part.name] = part.content.toString('utf8');
    }
  }

  details.originalFilename = filePart.filename;
  details.savedFilename = filename;
  details.receivedAt = new Date().toISOString();
  details.requestId = requestId;

  if (supabaseConfigured()) {
    details.uploadPath = await uploadFileToSupabase(filePart, requestId, filename);
    await insertRequestIntoSupabase(details);
  }

  if (SAVE_LOCAL_COPY) {
    await fs.mkdir(requestDir, { recursive: true });
    await fs.writeFile(path.join(requestDir, filename), filePart.content);
    await fs.writeFile(path.join(requestDir, 'request.json'), JSON.stringify(details, null, 2));
    await appendSpreadsheetRow(details);
  }

  try {
    await forwardToGoogleSheets(details);
  } catch (error) {
    console.error('Unable to forward request to Google Sheets:', error.message);
  }

  try {
    await sendWhatsAppNotification(details, requestId);
  } catch (error) {
    console.error('Unable to send WhatsApp notification:', error.message);
  }

  send(res, 200, JSON.stringify({ ok: true, requestId }), 'application/json');
}

async function serveIndex(res) {
  const html = await fs.readFile(path.join(ROOT, 'index.html'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (requestPath === '/' || requestPath === '/index.html') {
    return false;
  }

  const cleanPath = requestPath.replace(/^\/+/, '');
  if (!cleanPath) {
    return false;
  }

  const relativePath = cleanPath.replace(/^images\//i, '');
  const filePath = path.resolve(path.join(ROOT, relativePath));

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return true;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return false;
    }

    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/quote-request') {
      await handleQuoteRequest(req, res);
      return;
    }

    if (req.method === 'GET') {
      if (await serveStatic(req, res)) {
        return;
      }

      if (req.url === '/' || req.url === '/index.html') {
        await serveIndex(res);
        return;
      }
    }

    send(res, 404, 'Not found');
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }), 'application/json');
  }
});

server.listen(PORT, () => {
  console.log(`Layered Creations upload server running at http://localhost:${PORT}`);
  if (supabaseConfigured()) {
    console.log(`Uploaded quote files will be saved in Supabase Storage bucket "${SUPABASE_STORAGE_BUCKET}"`);
    console.log(`Customer quote requests will be saved in Supabase table "${SUPABASE_REQUESTS_TABLE}"`);
  }
  if (SAVE_LOCAL_COPY) {
    console.log(`Uploaded quote requests will be saved in ${UPLOAD_DIR}`);
    console.log(`Customer details spreadsheet will be saved at ${SPREADSHEET_PATH}`);
  }
});
