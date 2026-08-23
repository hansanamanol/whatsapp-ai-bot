const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');

// Express Web Server Setup (Web QR Code සඳහා)
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";

app.get('/', async (req, res) => {
    if (!latestQR) {
        return res.send('<h2>QR Code එක තවම Generate වෙනවා හෝ Bot සක්‍රීය වී ඇත... Page එක Refresh කර බලන්න.</h2>');
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Bot QR Code</title>
                    <meta http-equiv="refresh" content="10">
                </head>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
                    <h2>Scan this QR Code with WhatsApp</h2>
                    <img src="${qrImage}" style="border:10px solid white;border-radius:10px;width:300px;height:300px;"/>
                    <p>Page auto refreshes every 10 seconds</p>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code');
    }
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});

// ⚠️ 1. Gemini API Key & Model Setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const systemInstruction = `
You are an intelligent Gemini AI assistant working for the SLIIT IT Batch Representative (Monal). 
You behave like a natural conversational AI (just like the official Gemini app).

YOUR RESPONSIBILITIES:
1. Helping Students:
   - Answer student questions naturally, friendly, and accurately in Singlish, Sinhala, or English based on the user's language.
   - Assist them with Timetable info, Calendar link, Issue forms, and LIC contacts.

2. Assisting the Batch Rep (Admin):
   - When the Batch Rep asks you to post or announce something (even if spoken in Sinhala/Singlish), ALWAYS translate and rephrase it into clear, simple, professional English formatted as an official student notice.
   - Process images/notices directly when sent by the Batch Rep and create English notices from them.

Important Links & Info:
1. Timetable / Calendar:
   - Google Calendar Link: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Issue Reporting Form:
   - Link: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=publish-editor
3. SLIIT Support:
   - Link: https://ask.sliit.lk/
4. Lecturer In Charge (LIC) Details:
   - IT1150 - Technical Writing: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
   - IT1160 - Discrete Mathematics: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
   - IT1170 - Data Structures and Algorithms: Prof. Nathali Silva (nathali.s@sliit.lk)
   - SE1020 - Object Oriented Programming: Ms. Thilini Jayalath (thilini.j@sliit.lk)
   - IE1011 - Information Systems: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)
`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash",
    systemInstruction: systemInstruction 
});

const ADMIN_NUMBER = "94762513957@s.whatsapp.net";
const BATCH_GROUP_ID = "120363425513397101@g.us"; 

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr; // Save for web display
            console.log('\n=================== SCAN QR CODE BELOW ===================\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('\n==========================================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            latestQR = ""; // Clear QR once connected
            console.log('✅ WhatsApp AI Bot is Ready and Online!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];
            const isGroup = sender.endsWith('@g.us');

            const messageText = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || 
                              msg.message.imageMessage?.caption || "";

            // Admin Actions
            if (sender === ADMIN_NUMBER) {
                if (messageType === 'imageMessage') {
                    try {
                        await sock.sendMessage(sender, { text: "හරි මචං, මම Image එක බලලා English Notice එකක් හදලා Group එකට දාන්නම්..." }, { quoted: msg });

                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Image = buffer.toString('base64');
                        const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

                        const imagePart = {
                            inlineData: { data: base64Image, mimeType: mimeType }
                        };

                        const prompt = "Read this image notice and write a clear, attractive student announcement in SIMPLE ENGLISH. Use bold text for key dates, times, and instructions. Output ONLY the notice text without intro/outro.";
                        const result = await model.generateContent([prompt, imagePart]);
                        const announcement = result.response.text();

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                        await sock.sendMessage(BATCH_GROUP_ID, { image: buffer, caption: finalMsg });
                        await sock.sendMessage(sender, { text: "හරි, Image එකයි Simple English Notice එකයි Group එකට දැම්මා! 👍" }, { quoted: msg });
                        return;
                    } catch (err) {
                        console.error('Error processing Image:', err);
                        await sock.sendMessage(sender, { text: "අයියෝ Image එක කියවගන්න බැරි වුණා, ආයේ දාලා බලන්න." }, { quoted: msg });
                        return;
                    }
                }

                const text = messageText.toLowerCase();
                if (text.includes("කියපන්") || text.includes("කියන්න") || text.includes("දාපන්") || text.includes("දාන්න") || text.includes("inform") || text.includes("tell") || text.includes("post") || text.includes("announce")) {
                    try {
                        const prompt = `The Batch Rep sent this message: "${messageText}".
Translate and convert this message into a well-formatted, clean, and SIMPLE ENGLISH announcement notice for university students. 
Use clear structure, bold headings/key details, and appropriate emojis. 
CRITICAL: Output ONLY the final simple English notice text. Do NOT add conversational replies like "Sure, here is your message".`;

                        const result = await model.generateContent(prompt);
                        const announcement = result.response.text();

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                        await sock.sendMessage(BATCH_GROUP_ID, { text: finalMsg });
                        await sock.sendMessage(sender, { text: "හරි මචං, මම ඒක Simple English වලින් Translate කරලා Group එකට දැම්මා! 👍" }, { quoted: msg });
                        return;
                    } catch (err) {
                        console.error('Error broadcasting admin message:', err);
                    }
                }

                if (messageText) {
                    try {
                        const result = await model.generateContent(messageText);
                        const reply = result.response.text();
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                        return;
                    } catch (err) {
                        console.error('Error responding to admin:', err);
                        return;
                    }
                }
            }

            // Student Interactions
            if (isGroup) return;

            if (messageText) {
                try {
                    const result = await model.generateContent(messageText);
                    const replyText = result.response.text();
                    await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
                    console.log(`Replied to student: ${messageText}`);
                } catch (error) {
                    console.error('Error generating AI response:', error);
                }
            }
        }
    });
}

connectToWhatsApp();
