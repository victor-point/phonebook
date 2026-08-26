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

// ───── UCM API Sync (Old HTTPS API - Port 8443) ─────
const https = require('https');
const crypto = require('crypto');

// Konfigurasi Server UCM - Old HTTPS API
const UCM_CONFIG = {
    host: '10.88.1.2',
    port: 8443,              // Port Old API dari screenshot
    username: 'cdrapi',      // Username dari screenshot
    password: 'cdrapi123'    // Password cdrapi
};

// Fungsi helper: GET request ke UCM Old API (CGI format)
function ucmGet(path) {
    return new Promise((resolve, reject) => {
        const url = `https://${UCM_CONFIG.host}:${UCM_CONFIG.port}${path}`;
        console.log('[UCM GET]', url);
        
        const options = {
            hostname: UCM_CONFIG.host,
            port: UCM_CONFIG.port,
            path: path,
            method: 'GET',
            agent: new https.Agent({ rejectUnauthorized: false }),
            headers: {}
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const setCookie = res.headers['set-cookie'];
                resolve({ statusCode: res.statusCode, data, setCookie });
            });
        });

        req.on('error', error => reject(error));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout koneksi ke UCM')); });
        req.end();
    });
}

// Fungsi helper: GET request dengan cookie
function ucmGetWithCookie(path, cookie) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: UCM_CONFIG.host,
            port: UCM_CONFIG.port,
            path: path,
            method: 'GET',
            agent: new https.Agent({ rejectUnauthorized: false }),
            headers: { 'Cookie': cookie }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, data }));
        });

        req.on('error', error => reject(error));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

app.post('/api/contacts/sync-ucm', requireLogin, requireAdmin, async (req, res) => {
    try {
        // ===== TAHAP 1: Request Challenge =====
        console.log('\n========== SYNC UCM (Old API) ==========');
        console.log('--- TAHAP 1: REQUEST CHALLENGE ---');
        
        const chRes = await ucmGet(`/cgi?action=challenge&user=${UCM_CONFIG.username}`);
        console.log('Status:', chRes.statusCode);
        console.log('Response:', chRes.data);

        let chData;
        try { chData = JSON.parse(chRes.data); } catch(e) {
            // Old API kadang return format non-JSON
            console.log('Raw (bukan JSON):', chRes.data);
            throw new Error('Response challenge bukan JSON. Lihat terminal untuk raw data.');
        }

        if (chData.status !== 0 && !chData.challenge) {
            // Coba cek apakah challenge ada di level atas
            if (!chData.response || !chData.response.challenge) {
                throw new Error('Challenge gagal. Response: ' + JSON.stringify(chData));
            }
        }

        const challenge = chData.challenge || (chData.response && chData.response.challenge);
        console.log('Challenge diterima:', challenge);

        // Simpan cookie
        let cookie = chRes.setCookie ? chRes.setCookie.map(c => c.split(';')[0]).join('; ') : '';

        // ===== TAHAP 2: Login dengan MD5 Token =====
        console.log('\n--- TAHAP 2: LOGIN ---');
        const token = crypto.createHash('md5').update(challenge + UCM_CONFIG.password).digest('hex');
        console.log('MD5 Token:', token);

        const loginRes = await ucmGet(`/cgi?action=login&user=${UCM_CONFIG.username}&token=${token}`);
        console.log('Status:', loginRes.statusCode);
        console.log('Response:', loginRes.data);

        let loginData;
        try { loginData = JSON.parse(loginRes.data); } catch(e) {
            console.log('Raw (bukan JSON):', loginRes.data);
            throw new Error('Response login bukan JSON.');
        }

        // Cek cookie baru
        if (loginRes.setCookie) {
            cookie = loginRes.setCookie.map(c => c.split(';')[0]).join('; ');
        }

        const loginCookie = loginData.cookie || (loginData.response && loginData.response.cookie) || cookie;
        console.log('[+] Login selesai. Cookie/Token:', loginCookie);

        // ===== TAHAP 3: Ambil Daftar Ekstensi =====
        console.log('\n--- TAHAP 3: AMBIL DAFTAR EKSTENSI ---');
        
        // Coba beberapa endpoint yang umum di Old API
        const endpoints = [
            `/cgi?action=listAccount&cookie=${loginCookie}`,
            `/cgi?action=getExtenList&cookie=${loginCookie}`,
            `/cgi?action=listPJSIPExtension&cookie=${loginCookie}`
        ];
        
        let extData = null;
        for (const ep of endpoints) {
            try {
                console.log('Mencoba endpoint:', ep);
                const extRes = cookie 
                    ? await ucmGetWithCookie(ep, cookie) 
                    : await ucmGet(ep);
                console.log('Response:', extRes.data.substring(0, 500));
                
                const parsed = JSON.parse(extRes.data);
                if (parsed.status === 0 || parsed.response) {
                    extData = parsed;
                    console.log('[+] Endpoint berhasil!');
                    break;
                }
            } catch(e) {
                console.log('Endpoint gagal:', e.message);
            }
        }

        console.log('=========================================\n');

        res.json({
            success: true,
            message: 'Proses selesai. Cek terminal untuk melihat respon dari UCM.',
            data: []
        });

    } catch (error) {
        console.error('\n[!] Error:', error.message);
        console.log('=========================================\n');
        res.status(500).json({ success: false, message: error.message });
    }
});

// ───── Contacts API ─────
app.get('/api/contacts', (req, res) => {
    res.set(noCache);
    res.json(readData());
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
app.get('/phonebook.xml', (req, res) => {
    const contacts = readData();

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

// ───── GS XML Application ─────
app.get('/xmlapp', (req, res) => {
    const contacts = readData();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<GS_XML_Application>\n    <Display>\n        <Screen>\n';

    for (let i = 0; i < Math.min(contacts.length, 5); i++) {
        const c = contacts[i];
        const name = (c.firstName + ' ' + c.lastName).trim();
        xml += `            <DisplayString>\n                <X>0</X>\n                <Y>${i * 15}</Y>\n                <DisplayStr>${i + 1}. ${escapeXML(name)}</DisplayStr>\n            </DisplayString>\n`;
    }

    if (contacts.length === 0) {
        xml += `            <DisplayString>\n                <X>0</X>\n                <Y>0</Y>\n                <DisplayStr>Kontak Kosong</DisplayStr>\n            </DisplayString>\n`;
    }

    xml += '        </Screen>\n    </Display>\n    <SoftKeys>\n';

    for (let i = 0; i < Math.min(contacts.length, 3); i++) {
        const c = contacts[i];
        if (c.phone) {
            xml += `        <SoftKey>\n            <Label>Call ${i + 1}</Label>\n            <Action>\n                <Dial>\n                    <Account>0</Account>\n                    <Number>${escapeXML(c.phone)}</Number>\n                </Dial>\n            </Action>\n        </SoftKey>\n`;
        }
    }

    xml += '        <SoftKey>\n            <Label>Exit</Label>\n            <Action>\n                <QuitApp/>\n            </Action>\n        </SoftKey>\n';
    xml += '    </SoftKeys>\n</GS_XML_Application>';

    res.header('Content-Type', 'text/xml');
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
    console.log(`========================================================`);
    console.log(`Akun: admin/admin (full access), user/user (read only)`);
});
