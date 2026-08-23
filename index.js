const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// ⚠️ 1. Gemini API Key & Model Setup (gemini-2.5-flash)
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
    model: "gemini-2.5-flash",
    systemInstruction: systemInstruction 
});

// ⚠️ 2. ඔයාගේ Details
const ADMIN_NUMBER = "94762513957@s.whatsapp.net"; // Baileys format
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
            console.log('\n=================== SCAN QR CODE BELOW ===================\n');
            qrcode.generate(qr, { small: true });
            console.log('\n==========================================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
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

            // Caption හෝ Text Message එක ලබා ගැනීම
            const messageText = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || 
                              msg.message.imageMessage?.caption || "";

            // -------------------------------------------------------------
            // 👑 1. ADMIN INTERACTIONS (ඔයා Personal Phone එකෙන් කතා කරන කොට)
            // -------------------------------------------------------------
            if (sender === ADMIN_NUMBER) {

                // A) ඔයා Photo / Notice එකක් යැව්වොත්
                if (messageType === 'imageMessage') {
                    try {
                        await sock.sendMessage(sender, { text: "හරි මචං, මම Image එක බලලා English Notice එකක් හදලා Group එකට දාන්නම්..." }, { quoted: msg });

                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Image = buffer.toString('base64');
                        const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

                        const imagePart = {
                            inlineData: {
                                data: base64Image,
                                mimeType: mimeType
                            }
                        };

                        const prompt = "Read this image notice and write a clear, attractive student announcement in SIMPLE ENGLISH. Use bold text for key dates, times, and instructions. Output ONLY the notice text without intro/outro.";
                        const result = await model.generateContent([prompt, imagePart]);
                        const announcement = result.response.text();

                        const finalMsg = `📢 *ANNOUNCEMENT*\n\n${announcement}`;

                        // Group එකට Image එකයි Notice එකයි යැවීම
                        await sock.sendMessage(BATCH_GROUP_ID, { 
                            image: buffer, 
                            caption: finalMsg 
                        });

                        await sock.sendMessage(sender, { text: "හරි, Image එකයි Simple English Notice එකයි Group එකට දැම්මා! 👍" }, { quoted: msg });
                        return;
                    } catch (err) {
                        console.error('Error processing Image:', err);
                        await sock.sendMessage(sender, { text: "අයියෝ Image එක කියවගන්න බැරි වුණා, ආයේ දාලා බලන්න." }, { quoted: msg });
                        return;
                    }
                }

                // B) ඔයා සිංහලෙන්/සිංලිෂ් වලින් Group එකට දාන්න කියන මැසේජ්
                const text = messageText.toLowerCase();

                if (text.includes("කියපන්") || text.includes("කියන්න") || text.includes("දාපන්") || text.includes("දාන්න") || text.includes("inform") || text.includes("tell") || text.includes("post") || text.includes("announce")) {
                    try {
                        const prompt = `The Batch Rep sent this message (which might be in Sinhala or Singlish): "${messageText}".
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

                // C) ඔයා නිකන් වෙනත් දෙයක් ඇහුවොත් Direct Reply දීම
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

            // -------------------------------------------------------------
            // 🤖 2. STUDENT INTERACTIONS (ළමයින්ගේ Private Messages)
            // -------------------------------------------------------------
            if (isGroup) return; // Group ඇතුළේ වෙනත් අයගේ මැසේජ් වලට Auto Reply නොදෙයි

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
