const express = require('express');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const port = process.env.PORT || 3000;
let latestQR = '';

// Web page එකට QR එක පෙන්වීම
app.get('/', (req, res) => {
    if (!latestQR) {
        return res.send('<h2>Bot is starting or already connected! Check again in a few seconds...</h2>');
    }
    QRCode.toDataURL(latestQR, (err, url) => {
        if (err) return res.send('Error generating QR code');
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background-color:#111; color:#fff;">
                    <h2>Scan this QR Code using WhatsApp</h2>
                    <img src="${url}" style="width:300px; height:300px; border:10px solid white; border-radius:10px;" />
                </body>
            </html>
        `);
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Client setup
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    }
});

client.on('qr', (qr) => {
    latestQR = qr; // Save latest QR
    console.log('New QR code generated! Open your Railway Domain URL to scan.');
});

client.on('ready', () => {
    latestQR = ''; // Clear QR on connect
    console.log('Client is ready!');
});
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ⚠️ 1. ඔයාගේ Gemini API Key එක
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ⚠️ 2. ඔයාගේ Personal WhatsApp Number එක (947XXXXXXXX@c.us)
const ADMIN_NUMBER = "94762513957@c.us"; 

// ⚠️ 3. Batch WhatsApp Group ID එක
const BATCH_GROUP_ID = "120363425513397101@g.us"; 

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
    model: "gemini-3.5-flash-lite",
    systemInstruction: systemInstruction 
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above using WhatsApp Linked Devices!');
});

client.on('ready', () => {
    console.log('WhatsApp AI Bot is Ready and Online!');
});

client.on('message', async (msg) => {

    // -------------------------------------------------------------
    // 👑 1. ADMIN INTERACTIONS (ඔයා Personal Phone එකෙන් කතා කරන කොට)
    // -------------------------------------------------------------
    if (msg.from === ADMIN_NUMBER) {

        // A) ඔයා Photo / Notice එකක් යැව්වොත්
        if (msg.hasMedia) {
            try {
                await msg.reply("හරි මචං, මම Image එක බලලා English Notice එකක් හදලා Group එකට දාන්නම්...");
                const media = await msg.downloadMedia();
                
                const imagePart = {
                    inlineData: {
                        data: media.data,
                        mimeType: media.mimetype
                    }
                };

                const prompt = "Read this image notice and write a clear, attractive student announcement in SIMPLE ENGLISH. Use bold text for key dates, times, and instructions. Output ONLY the notice text without intro/outro.";
                const result = await model.generateContent([prompt, imagePart]);
                const announcement = result.response.text();

                const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;
                
                // Group එකට යැවීම
                await client.sendMessage(BATCH_GROUP_ID, media, { caption: finalMsg });
                await msg.reply("හරි, Image එකයි Simple English Notice එකයි Group එකට දැම්මා! 👍");
                return;
            } catch (err) {
                console.error('Error processing Image:', err);
                await msg.reply("අයියෝ Image එක කියවගන්න බැරි වුණා, ආයේ දාලා බලන්න.");
                return;
            }
        }

        // B) ඔයා සිංහලෙන්/සිංලිෂ් වලින් Group එකට දාන්න කියන මැසේජ්
        const text = msg.body.toLowerCase();
        
        if (text.includes("කියපන්") || text.includes("කියන්න") || text.includes("දාපන්") || text.includes("දාන්න") || text.includes("inform") || text.includes("tell") || text.includes("post") || text.includes("announce")) {
            try {
                const prompt = `The Batch Rep sent this message (which might be in Sinhala or Singlish): "${msg.body}".
Translate and convert this message into a well-formatted, clean, and SIMPLE ENGLISH announcement notice for university students. 
Use clear structure, bold headings/key details, and appropriate emojis. 
CRITICAL: Output ONLY the final simple English notice text. Do NOT add conversational replies like "Sure, here is your message".`;

                const result = await model.generateContent(prompt);
                const announcement = result.response.text();

                const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                await client.sendMessage(BATCH_GROUP_ID, finalMsg);
                await msg.reply("හරි මචං, මම ඒක Simple English වලින් Translate කරලා Group එකට දැම්මා! 👍");
                return;
            } catch (err) {
                console.error('Error broadcasting admin message:', err);
            }
        }

        // ඔයා නිකන් වෙනත් දෙයක් ඇහුවොත් Gemini එකෙන් ඔයාට Direct Reply දීම
        try {
            const result = await model.generateContent(msg.body);
            const reply = result.response.text();
            await msg.reply(reply);
            return;
        } catch (err) {
            console.error('Error responding to admin:', err);
            return;
        }
    }

    // -------------------------------------------------------------
    // 🤖 2. STUDENT INTERACTIONS (ළමයින්ගේ Private Messages)
    // -------------------------------------------------------------
    if (msg.from.endsWith('@g.us')) return;

    try {
        const result = await model.generateContent(msg.body);
        const replyText = result.response.text();
        await msg.reply(replyText);
        console.log(`Replied to student: ${msg.body}`);
    } catch (error) {
        console.error('Error generating AI response:', error);
    }
});

client.initialize();
