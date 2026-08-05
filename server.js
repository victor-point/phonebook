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
    
    let xmlString = '<?xml version="1.0" encoding="UTF-8"?>\n<AddressBook>\n';
    
    contacts.forEach(contact => {
        xmlString += '    <Contact>\n';
        if (contact.firstName) xmlString += `        <FirstName>${escapeXML(contact.firstName)}</FirstName>\n`;
        if (contact.lastName) xmlString += `        <LastName>${escapeXML(contact.lastName)}</LastName>\n`;
        
        if (contact.phone) {
            xmlString += '        <Phone>\n';
            xmlString += `            <phonenumber>${escapeXML(contact.phone)}</phonenumber>\n`;
            xmlString += '            <accountindex>0</accountindex>\n';
            xmlString += '        </Phone>\n';
        }
        xmlString += '    </Contact>\n';
    });

    xmlString += '</AddressBook>';

    res.header('Content-Type', 'text/xml');
    res.send(xmlString);
});

app.listen(PORT, '::', () => {
    console.log(`========================================================`);
    console.log(`Server Phonebook berjalan di port ${PORT}`);
    console.log(`- Buka UI di browser: http://<IP_SERVER>:${PORT}`);
    console.log(`- URL untuk Grandstream: http://<IP_SERVER>:${PORT}/phonebook.xml`);
    console.log(`========================================================`);
});
