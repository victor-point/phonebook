const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001; // Changed to port 3001
const DATA_FILE = path.join(__dirname, 'contacts.json');

app.use(cors());
app.use(express.json());
// Serve static files from current directory
app.use(express.static(__dirname));

// Helper to read data
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

// Helper to write data
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

// API to get contacts for the web UI
app.get('/api/contacts', (req, res) => {
    res.json(readData());
});

// API to save contacts from the web UI
app.post('/api/contacts', (req, res) => {
    const contacts = req.body;
    if (Array.isArray(contacts)) {
        writeData(contacts);
        res.json({ success: true, message: 'Contacts saved successfully' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid data format' });
    }
});

// The magical endpoint for the Grandstream phone
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
        
        // firstName = No. Ext (nomor ekstensi), digunakan sebagai nomor dial
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

// Endpoint khusus untuk XML Application (GS_XML_Application)
app.get('/xmlapp', (req, res) => {
    const contacts = readData();
    
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<GS_XML_Application>\n    <Display>\n        <Screen>\n';
    
    // Tampilkan maksimal 5 kontak di layar (keterbatasan resolusi)
    for (let i = 0; i < Math.min(contacts.length, 5); i++) {
        const c = contacts[i];
        const name = (c.firstName + ' ' + c.lastName).trim();
        xml += `            <DisplayString>\n                <X>0</X>\n                <Y>${i * 15}</Y>\n                <DisplayStr>${i+1}. ${escapeXML(name)}</DisplayStr>\n            </DisplayString>\n`;
    }
    
    if (contacts.length === 0) {
        xml += `            <DisplayString>\n                <X>0</X>\n                <Y>0</Y>\n                <DisplayStr>Kontak Kosong</DisplayStr>\n            </DisplayString>\n`;
    }

    xml += '        </Screen>\n    </Display>\n    <SoftKeys>\n';
    
    // Tambahkan softkey untuk menelepon (Maksimal 3 karena 1 dipakai untuk Exit)
    let softkeyCount = 0;
    for (let i = 0; i < Math.min(contacts.length, 3); i++) {
        const c = contacts[i];
        if (c.phone) {
            xml += `        <SoftKey>\n            <Label>Call ${i+1}</Label>\n            <Action>\n                <Dial>\n                    <Account>0</Account>\n                    <Number>${escapeXML(c.phone)}</Number>\n                </Dial>\n            </Action>\n        </SoftKey>\n`;
            softkeyCount++;
        }
    }
    
    xml += '        <SoftKey>\n            <Label>Exit</Label>\n            <Action>\n                <QuitApp/>\n            </Action>\n        </SoftKey>\n';
    xml += '    </SoftKeys>\n</GS_XML_Application>';

    res.header('Content-Type', 'text/xml');
    res.send(xml);
});

app.listen(PORT, '::', () => {
    console.log(`========================================================`);
    console.log(`Server Phonebook berjalan di port ${PORT}`);
    console.log(`- Admin UI  : http://10.1.2.231:${PORT}/`);
    console.log(`- View UI   : http://10.1.2.231:${PORT}/view.html`);
    console.log(`- Grandstream XML: http://10.1.2.231:${PORT}/phonebook.xml`);
    console.log(`========================================================`);
});
