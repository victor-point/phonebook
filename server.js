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
