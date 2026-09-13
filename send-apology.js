require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const MATARA_STUDENTS_FILE = path.join(DATA_DIR, 'matara_students.json');

let mataraStudents = [];
try {
    if (fs.existsSync(MATARA_STUDENTS_FILE)) {
        mataraStudents = JSON.parse(fs.readFileSync(MATARA_STUDENTS_FILE, 'utf8'));
    }
} catch (e) { console.error('Error loading students:', e); }

const MESSAGE = `📢 *Urgent Correction* ⚠️

Dear students,

There was a minor error in calculating the time for the IT1160 DM Lab 03 Deadline Reminder sent this morning.

The bot stated "8 hours", but that is incorrect! ❌

⏰ *The actual deadline is TODAY (September 13) at 10:30 AM!* 
This means there is much less time remaining, not 8 hours!

If you haven't submitted yet, please submit *immediately*! 🏃‍♂️💨

This happened due to a bug in the time calculation code. It has now been fixed.

We apologize for this mistake! 🙏
- Monal Hansana (Batch Rep)`;

async function sendNow() {
    console.log("⏳ Connecting to WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info_baileys'));
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`✅ Connected! Sending message...`);
            
            // 1. Send to all Matara students
            for (const jid of mataraStudents) {
                try {
                    await sock.sendMessage(jid, { text: MESSAGE });
                    console.log(`✅ Sent to student: ${jid}`);
                    await new Promise(r => setTimeout(r, 2000)); // 2 seconds delay
                } catch (e) {
                    console.error(`❌ Failed to send to ${jid}:`, e.message);
                }
            }

            // 2. Send to Main Group
            if (process.env.GROUP_JID) {
                try {
                    await sock.sendMessage(process.env.GROUP_JID, { text: MESSAGE });
                    console.log(`✅ Sent to Group: ${process.env.GROUP_JID}`);
                } catch (e) {
                    console.error(`❌ Failed to send to group:`, e.message);
                }
            }

            console.log('🎉 All messages sent successfully!');
            process.exit(0);
        }
    });
}

sendNow();
