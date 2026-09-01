const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const session = require('express-session');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'contacts.json');

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(session({
    secret: 'phonebook-ucm6308a-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 8 * 60 * 60 * 1000, // 8 jam
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// ───── User Accounts ─────
const USERS = {
    admin: { password: 'admin', role: 'admin' },
    user:  { password: 'user',  role: 'user'  }
};

// ───── Middleware ─────
const noCache = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
};

function requireLogin(req, res, next) {
    if (req.session && req.session.user) return next();
    // API request → JSON error, page request → redirect
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Login diperlukan' });
    }
    res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.role === 'admin') return next();
    res.status(403).json({ success: false, message: 'Akses admin diperlukan' });
}

// ───── Page Routes ─────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'view.html'));
});

app.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/admin');
    res.set(noCache);
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/admin', requireLogin, (req, res) => {
    res.set(noCache);
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files
app.use(express.static(__dirname));

// ───── Auth API ─────
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const u = USERS[username];
    if (u && u.password === password) {
        req.session.user = username;
        req.session.role = u.role;
        res.json({ success: true, user: username, role: u.role });
    } else {
        res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

app.get('/api/session', (req, res) => {
    res.set(noCache);
    if (req.session && req.session.user) {
        res.json({ loggedIn: true, user: req.session.user, role: req.session.role });
    } else {
        res.json({ loggedIn: false });
    }
});

// ───── Data Helpers ─────
function readData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Error reading data:', err);
    }
    return [];
}

function writeData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error writing data:', err);
    }
}

function escapeXML(unsafe) {
    if (!unsafe) return '';
    return unsafe.toString().replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// ───── UCM API Sync ─────
const https = require('https');
const crypto = require('crypto');

// Konfigurasi Server UCM
const UCM_SERVERS = [
    {
        name: 'UCM CMI-SS3',
        host: '10.88.1.2',
        port: 8089,
        username: 'api',
        password: 'Chooper2108'
    },
    {
        name: 'UCM CMI-Panin',
        host: '10.8.22.2',
        port: 8443,
        username: 'cdrapi',
        password: 'cdrapi123'
    }
];

// Helper: HTTPS GET request
function ucmGet(host, port, path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: host, port, path, method: 'GET',
            agent: new https.Agent({ rejectUnauthorized: false })
        };
        console.log(`[GET] https://${host}:${port}${path}`);
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, data, setCookie: res.headers['set-cookie'] }));
        });
        req.on('error', e => reject(e));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

// Helper: HTTPS POST request (JSON)
function ucmPost(host, port, path, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        const options = {
            hostname: host, port, path, method: 'POST',
            agent: new https.Agent({ rejectUnauthorized: false }),
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        if (cookie) options.headers['Cookie'] = cookie;
        console.log(`[POST] https://${host}:${port}${path}`);
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, data, setCookie: res.headers['set-cookie'] }));
        });
        req.on('error', e => reject(e));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(payload);
        req.end();
    });
}


// ===== FUNGSI: Ambil Data Langsung dari UCM (Live Fetch) =====
async function fetchUCMContacts(C) {
    const chRes = await ucmPost(C.host, C.port, '/api', { request: { action: 'challenge', user: C.username } });
    const chData = JSON.parse(chRes.data);
    if (chData.status !== 0) throw new Error('Challenge gagal');
    
    let cookie = chRes.setCookie ? chRes.setCookie.map(c => c.split(';')[0]).join('; ') : '';
    const challenge = chData.response.challenge;
    const token = require('crypto').createHash('md5').update(challenge + C.password).digest('hex');
    
    const loginRes = await ucmPost(C.host, C.port, '/api', { request: { action: 'login', user: C.username, token } }, cookie);
    const loginData = JSON.parse(loginRes.data);
    if (loginData.status !== 0) throw new Error('Login gagal');
    const apiCookie = loginData.response.cookie;
    
    if (loginRes.setCookie) cookie = loginRes.setCookie.map(c => c.split(';')[0]).join('; ');

    const extPayload = JSON.stringify({ request: { action: 'listAccount', cookie: apiCookie } });
    const r = await ucmPost(C.host, C.port, '/api', extPayload, cookie);
    const parsed = JSON.parse(r.data);
    
    if (parsed.status !== 0 || !parsed.response) return [];

    let extensions = parsed.response.account || parsed.response.extension || [];
    if (!Array.isArray(extensions)) extensions = [extensions];
    
    return extensions.map(item => {
        const extNum = item.extension || item.account || item.number || '';
        const fullName = (item.fullname || item.callerid || item.name || '').trim();
        const dept = item.department_name || item.department || '';
        return { firstName: extNum, lastName: fullName, phone: dept };
    }).filter(c => c.firstName);
}

async function fetchAllUCMContacts() {
    const promises = UCM_SERVERS.map(async (server) => {
        try {
            const contacts = await fetchUCMContacts(server);
            return { server: server.name, success: true, contacts };
        } catch (error) {
            console.error(`[UCM Fetch Error] ${server.name} (${server.host}):`, error.message);
            return { server: server.name, success: false, error: error.message, contacts: [] };
        }
    });

    return await Promise.all(promises);
}

async function getLiveMergedContacts() {
    let localData = readData();
    const map = new Map();
    localData.forEach(c => map.set(c.firstName, c));

    const ucmResults = await fetchAllUCMContacts();
    let isModified = false;

    for (const res of ucmResults) {
        if (res.success && res.contacts && res.contacts.length > 0) {
            res.contacts.forEach(c => map.set(c.firstName, c));
            isModified = true;
        }
    }

    if (isModified) {
        localData = Array.from(map.values());
        writeData(localData);
    }
    
    return Array.from(map.values());
}

app.post('/api/contacts/sync-ucm', requireLogin, requireAdmin, async (req, res) => {
    try {
        const ucmResults = await fetchAllUCMContacts();
        let totalContacts = 0;
        let messages = [];
        let allContacts = [];

        ucmResults.forEach(r => {
            if (r.success) {
                totalContacts += r.contacts.length;
                messages.push(`${r.server}: ${r.contacts.length} kontak`);
                allContacts = allContacts.concat(r.contacts);
            } else {
                messages.push(`${r.server}: Gagal (${r.error})`);
            }
        });

        res.json({ 
            success: true, 
            message: `Sinkronisasi selesai.\n${messages.join('\\n')}`, 
            data: allContacts 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ───── Contacts API ─────
app.get('/api/contacts', async (req, res) => {
    res.set(noCache);
    res.json(await getLiveMergedContacts());
});

// Save (overwrite) all contacts — admin only
app.post('/api/contacts', requireLogin, requireAdmin, (req, res) => {
    const contacts = req.body;
    if (Array.isArray(contacts)) {
        writeData(contacts);
        res.json({ success: true, message: 'Contacts saved successfully' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid data format' });
    }
});

// Import contacts — admin only, skip duplicates or update name
app.post('/api/contacts/import', requireLogin, requireAdmin, (req, res) => {
    const incoming = req.body;
    if (!Array.isArray(incoming)) {
        return res.status(400).json({ success: false, message: 'Invalid data format' });
    }
    const existing = readData();
    const existingMap = new Map();
    existing.forEach((c, idx) => {
        existingMap.set(c.firstName, idx);
    });
    let added = 0, skipped = 0, updated = 0;
    incoming.forEach(c => {
        if (existingMap.has(c.firstName)) {
            const idx = existingMap.get(c.firstName);
            if (existing[idx].lastName !== c.lastName) {
                existing[idx].lastName = c.lastName;
                if (c.phone) existing[idx].phone = c.phone;
                updated++;
            } else {
                skipped++;
            }
        } else {
            existing.push(c);
            existingMap.set(c.firstName, existing.length - 1);
            added++;
        }
    });
    writeData(existing);
    res.json({ success: true, added, skipped, updated, total: existing.length });
});

// Delete single contact — admin only
app.delete('/api/contacts/:ext', requireLogin, requireAdmin, (req, res) => {
    const ext = req.params.ext;
    let data = readData();
    const before = data.length;
    data = data.filter(c => c.firstName !== ext);
    if (data.length < before) {
        writeData(data);
        res.json({ success: true, message: 'Deleted' });
    } else {
        res.status(404).json({ success: false, message: 'Not found' });
    }
});

// Update single contact — admin only
app.put('/api/contacts/:ext', requireLogin, requireAdmin, (req, res) => {
    const ext = req.params.ext;
    const data = readData();
    const idx = data.findIndex(c => c.firstName === ext);
    if (idx >= 0) {
        data[idx] = req.body;
        writeData(data);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Not found' });
    }
});

// ───── Grandstream XML ─────
app.get('/phonebook.xml', async (req, res) => {
    const contacts = await getLiveMergedContacts();

    let xmlString = '<AddressBook>\n';
    xmlString += '<pbgroup>\n<id>1</id>\n<name>Blacklist</name>\n</pbgroup>\n';
    xmlString += '<pbgroup>\n<id>2</id>\n<name>Whitelist</name>\n</pbgroup>\n';

    contacts.forEach((contact, index) => {
        xmlString += '<Contact>\n';
        xmlString += `<id>${index + 1}</id>\n`;

        if (contact.firstName) {
            xmlString += `<FirstName>${escapeXML(contact.firstName)}</FirstName>\n`;
        } else {
            xmlString += '<FirstName/>\n';
        }

        if (contact.lastName) {
            xmlString += `<LastName>${escapeXML(contact.lastName)}</LastName>\n`;
        } else {
            xmlString += '<LastName/>\n';
        }

        xmlString += '<Frequent>0</Frequent>\n';
        xmlString += '<Phone type="Work">\n';

        const dialNumber = contact.firstName || '';
        if (dialNumber) {
            xmlString += `<phonenumber>${escapeXML(dialNumber)}</phonenumber>\n`;
        } else {
            xmlString += '<phonenumber/>\n';
        }

        xmlString += '<accountindex>1</accountindex>\n';
        xmlString += '</Phone>\n';
        xmlString += '<Primary>0</Primary>\n';
        xmlString += '</Contact>\n';
    });

    xmlString += '</AddressBook>';
    res.header('Content-Type', 'text/xml');
    res.send(xmlString);
});

// ───── Grandstream XML APP (Interactive Browser) ─────

// 1. Main Menu
app.get('/xmlapp', (req, res) => {
    const host = req.get('host');
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<GrandstreamXML>\n`;
    xml += `  <Menu name="App Phonebook">\n`;
    xml += `    <MenuItem>\n`;
    xml += `      <Prompt>Cari Kontak</Prompt>\n`;
    xml += `      <URI>http://${host}/xmlapp/search</URI>\n`;
    xml += `    </MenuItem>\n`;
    xml += `    <MenuItem>\n`;
    xml += `      <Prompt>Semua Kontak</Prompt>\n`;
    xml += `      <URI>http://${host}/xmlapp/results</URI>\n`;
    xml += `    </MenuItem>\n`;
    xml += `  </Menu>\n`;
    xml += `</GrandstreamXML>`;
    res.type('application/xml');
    res.send(xml);
});

// 2. Search Input Screen
app.get('/xmlapp/search', (req, res) => {
    const host = req.get('host');
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<GrandstreamXML>\n`;
    xml += `  <InputScreen>\n`;
    xml += `    <DisplayString>Cari Nama/Ext:</DisplayString>\n`;
    xml += `    <URL>http://${host}/xmlapp/results</URL>\n`;
    xml += `    <InputField>\n`;
    xml += `      <Prompt>Keyword</Prompt>\n`;
    xml += `      <Parameter>q</Parameter>\n`;
    xml += `      <Type>alpha</Type>\n`;
    xml += `    </InputField>\n`;
    xml += `  </InputScreen>\n`;
    xml += `</GrandstreamXML>`;
    res.type('application/xml');
    res.send(xml);
});

// 3. Directory Results (with optional search)
app.get('/xmlapp/results', async (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    const contacts = await getLiveMergedContacts();
    
    const filtered = contacts.filter(c => 
        (c.lastName || '').toLowerCase().includes(q) || 
        (c.firstName || '').toLowerCase().includes(q)
    );

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<GrandstreamXML>\n`;
    xml += `  <Directory name="${q ? 'Hasil: ' + escapeXML(req.query.q || '') : 'Semua Kontak'}">\n`;
    
    if (filtered.length === 0) {
        xml += `    <DirectoryEntry>\n`;
        xml += `      <Name>Tidak ditemukan</Name>\n`;
        xml += `      <Telephone></Telephone>\n`;
        xml += `    </DirectoryEntry>\n`;
    } else {
        filtered.forEach(c => {
            const name = c.lastName ? escapeXML(c.lastName) : 'Tanpa Nama';
            const num = c.firstName ? escapeXML(c.firstName) : '';
            xml += `    <DirectoryEntry>\n`;
            xml += `      <Name>${name}</Name>\n`;
            xml += `      <Telephone>${num}</Telephone>\n`;
            xml += `    </DirectoryEntry>\n`;
        });
    }
    
    xml += `  </Directory>\n`;
    xml += `</GrandstreamXML>`;
    res.type('application/xml');
    res.send(xml);
});

// ───── Start Server ─────
app.listen(PORT, '::', () => {
    let localIP = 'localhost';
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
            }
        }
    }

    console.log(`========================================================`);
    console.log(`Server Phonebook berjalan di port ${PORT}`);
    console.log(`- View UI   : http://${localIP}:${PORT}/`);
    console.log(`- Login     : http://${localIP}:${PORT}/login`);
    console.log(`- Admin UI  : http://${localIP}:${PORT}/admin`);
    console.log(`- Grandstream XML: http://${localIP}:${PORT}/phonebook.xml`);
    console.log(`- XML App   : http://${localIP}:${PORT}/xmlapp`);
    console.log(`========================================================`);
    console.log(`Akun: admin/admin (full access), user/user (read only)`);
});
