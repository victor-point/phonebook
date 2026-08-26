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
const UCM_OLD = {
    host: '10.88.1.2',
    port: 8443,
    username: 'cdrapi',
    password: 'cdrapi123'
};

const UCM_NEW = {
    host: '10.88.1.2',
    port: 8089,
    username: 'api',
    password: 'Chooper2108'
};

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

// ===== ENDPOINT: Sync UCM (Format yang berhasil: POST /api) =====
app.post('/api/contacts/sync-ucm', requireLogin, requireAdmin, async (req, res) => {
    const C = UCM_NEW;
    console.log('\n========== SYNC UCM API ==========');
    
    try {
        // TAHAP 1: Challenge
        console.log('--- TAHAP 1: CHALLENGE ---');
        const chRes = await ucmPost(C.host, C.port, '/api', { 
            request: { action: 'challenge', user: C.username } 
        });
        const chData = JSON.parse(chRes.data);
        if (chData.status !== 0) throw new Error('Challenge gagal: ' + chRes.data);
        const challenge = chData.response.challenge;
        console.log('[+] Challenge:', challenge);
        
        let cookie = chRes.setCookie ? chRes.setCookie.map(c => c.split(';')[0]).join('; ') : '';

        // TAHAP 2: Login
        console.log('--- TAHAP 2: LOGIN ---');
        const token = crypto.createHash('md5').update(challenge + C.password).digest('hex');
        const loginRes = await ucmPost(C.host, C.port, '/api', { 
            request: { action: 'login', user: C.username, token } 
        }, cookie);
        const loginData = JSON.parse(loginRes.data);
        if (loginData.status !== 0) throw new Error('Login gagal: ' + loginRes.data);
        const apiCookie = loginData.response.cookie;
        console.log('[+] Login berhasil! Cookie:', apiCookie);
        
        if (loginRes.setCookie) {
            cookie = loginRes.setCookie.map(c => c.split(';')[0]).join('; ');
        }

        // TAHAP 3: Ambil Daftar Ekstensi
        console.log('--- TAHAP 3: MENGAMBIL DAFTAR EKSTENSI ---');
        console.log('Mencoba action: listAccount ke endpoint /api...');
        
        // Sesuai manual, kita gunakan listAccount dan sertakan cookie di payload JSON
        const extPayload = JSON.stringify({ 
            request: { 
                action: 'listAccount', 
                cookie: apiCookie 
            } 
        });
        
        const r = await ucmPost(C.host, C.port, '/api', extPayload, cookie);
        const parsed = JSON.parse(r.data);
        console.log(`[listAccount] status: ${parsed.status} | response keys: ${Object.keys(parsed.response || {}).join(', ')}`);
        
        if (parsed.status === -47) {
            console.log('\n[!] ERROR -47: PERMISSION DENIED (TIDAK ADA HAK AKSES)');
            throw new Error('Status -47: Akun "api" tidak memiliki izin (privilege) untuk menjalankan "listAccount". Silakan centang hak akses di menu UCM.');
        }
        
        if (parsed.status === 0 && parsed.response) {
            console.log('\n[+] BERHASIL MENGAMBIL DATA EKSTENSI!');
            console.log('Response (500 char):', JSON.stringify(parsed).substring(0, 500));
            
            const responseData = parsed.response;
            let extensions = responseData.account || responseData.extension || [];
            if (!Array.isArray(extensions)) extensions = [extensions];
            
            console.log(`Total ekstensi: ${extensions.length}`);
            
            const contacts = extensions.map(ext => {
                const extNum = ext.extension || ext.account || '';
                const fullName = (ext.fullname || ext.callerid || '').trim();
                const dept = ext.department || '';
                return { firstName: extNum, lastName: fullName, phone: dept };
            }).filter(c => c.firstName);

            return res.json({
                success: true,
                message: `Berhasil mengambil ${contacts.length} ekstensi dari UCM.`,
                data: contacts
            });
        } else {
            throw new Error(`Gagal mengambil data. Status: ${parsed.status}. Raw: ${r.data}`);
        }

        console.log('==================================\n');

        if (extResult && winningAction) {
            // Parse data ekstensi dari response
            const responseData = extResult.response;
            let extensions = [];
            
            // Coba beberapa kemungkinan struktur response
            if (Array.isArray(responseData)) {
                extensions = responseData;
            } else if (responseData.extension) {
                extensions = Array.isArray(responseData.extension) ? responseData.extension : [responseData.extension];
            } else if (responseData.account) {
                extensions = Array.isArray(responseData.account) ? responseData.account : [responseData.account];
            } else {
                // Coba cari array di dalam response
                for (const key of Object.keys(responseData)) {
                    if (Array.isArray(responseData[key])) {
                        extensions = responseData[key];
                        console.log(`Data ekstensi ditemukan di key: "${key}"`);
                        break;
                    }
                }
            }

            console.log(`Total ekstensi ditemukan: ${extensions.length}`);
            if (extensions.length > 0) {
                console.log('Contoh data pertama:', JSON.stringify(extensions[0]));
            }

            // Map ke format phonebook kita
            const contacts = extensions.map(ext => {
                const extNum = ext.extension || ext.exten || ext.account || ext.number || '';
                const firstName = ext.first_name || ext.firstname || ext.callerid || ext.caller_id || '';
                const lastName = ext.last_name || ext.lastname || '';
                const fullName = (firstName + ' ' + lastName).trim();
                const dept = ext.department || ext.dept || '';
                return { firstName: extNum, lastName: fullName, phone: dept };
            }).filter(c => c.firstName); // Filter yang punya nomor ext

            res.json({
                success: true,
                message: `Berhasil! Action: ${winningAction}. Ditemukan ${contacts.length} ekstensi.`,
                data: contacts
            });
        } else {
            res.json({
                success: true,
                message: 'Login berhasil tapi belum menemukan action yang tepat. Cek terminal untuk detail.',
                data: []
            });
        }

    } catch (error) {
        console.error('[!] Error:', error.message);
        console.log('==================================\n');
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
