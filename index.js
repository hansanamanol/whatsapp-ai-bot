const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";

app.get('/', async (req, res) => {
    if (!latestQR) return res.send("<body style='background:#0d1117;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;'><h2>🚀 HansanaBot is Active & Ready!</h2></body>");
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`<body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;background:#0d1117;color:white;font-family:sans-serif;">
        <h2>Scan QR Code to Connect HansanaBot</h2>
        <img src="${qrImage}" style="width:280px;border:8px solid white;border-radius:10px;"/>
    </body>`);
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `
You are HansanaBot, an intelligent and friendly Gemini AI Assistant created for SLIIT IT Students.
You represent and assist the SLIIT IT Batch Representative: Monal Hansana.

YOUR CORE ROLE & RESPONSIBILITIES:
- Answer student questions about SLIIT Y1S2 modules, timetables, LMS links, LIC emails, forms, and general academic guidelines.
- Reply naturally in polite Singlish, English, or Sinhala depending on how the student texts.
- Keep replies short, clean, structured, and easy to read.

BATCH REPRESENTATIVE DETAILS:
- Batch Rep Name: Monal Hansana
- Contact Number: +94 76 251 3957 (076 251 3957)
- Official SLIIT Email: it26100930@my.sliit.lk
- Role: SLIIT IT Batch Representative (Matara / General Cohort)

SLIIT ACADEMIC & LIC INFORMATION (Y1S2):
1. IT1170 - Data Structures and Algorithms (DSA) | LIC: Prof. Nathali Silva (nathali.s@sliit.lk)
2. IT1160 - Discrete Mathematics | LIC: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
3. SE1020 - Object Oriented Programming (OOP) | LIC: Ms. Thilini Jayalath (thilini.j@sliit.lk)
4. IT1150 - Technical Writing | LIC: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
5. IE1011 - Information Systems | LIC: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)

IMPORTANT SLIIT LINKS:
- Timetable / Google Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
- LMS (Courseweb): https://courseweb.sliit.lk/
- Eduscope (Recordings): https://eduscope.sliit.lk/
- Student Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=publish-editor
- Helpdesk: https://ask.sliit.lk/

IMPORTANT RULES:
- Minimum 80% attendance is required for labs and lectures to qualify for final exams.
- Do NOT perform any administrative tasks like posting messages to groups.
`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite",
    systemInstruction: systemInstruction 
});

const userCooldowns = new Map();
const COOLDOWN_TIME_MS = 3000; 

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        keepAliveIntervalMs: 20000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            latestQR = qr;
            console.log("👉 New QR Code available on Railway URL!");
        }
        if (connection === 'open') {
            latestQR = "";
            console.log('🚀 ✅ HansanaBot is ONLINE & READY!');
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("🔄 Reconnecting...");
                setTimeout(() => startBot(), 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                let remoteJid = msg.key.remoteJid;
                const isGroup = remoteJid.endsWith('@g.us');

                if (isGroup) continue;

                // 🎯 LID to Phone Number Conversion Fix
                if (remoteJid.endsWith('@lid')) {
                    if (remoteJid.includes("17848192627279")) {
                        remoteJid = "94762513957@s.whatsapp.net"; // Monal's Phone Number
                    }
                }

                const now = Date.now();
                if (userCooldowns.has(remoteJid)) {
                    if (now - userCooldowns.get(remoteJid) < COOLDOWN_TIME_MS) continue;
                }
                userCooldowns.set(remoteJid, now);

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || "";
                
                const imgMsg = msg.message.imageMessage;
                if (!text && !imgMsg) continue;

                console.log(`📩 Message from ${remoteJid}: "${text}"`);
                await sock.sendPresenceUpdate('composing', remoteJid);

                let replyText = "";

                if (imgMsg) {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const imagePart = { inlineData: { data: buffer.toString('base64'), mimeType: imgMsg.mimetype || 'image/jpeg' } };
                    const prompt = text ? text : "Explain or solve this academic image for the student.";
                    const result = await model.generateContent([prompt, imagePart]);
                    replyText = result.response.text();
                } else {
                    const result = await model.generateContent(text);
                    replyText = result.response.text();
                }

                if (replyText) {
                    // Direct target sending without relying purely on quoted LID
                    await sock.sendMessage(remoteJid, { text: replyText });
                    console.log(`✅ Sent directly to ${remoteJid}`);
                }

            } catch (err) {
                console.error("❌ Error handling message:", err);
            }
        }
    });
}

startBot();
