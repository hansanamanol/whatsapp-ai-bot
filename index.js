// ================================================================
//  📦 DEPENDENCIES
// ================================================================
require('dotenv').config();
const cron = require('node-cron');

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

// ================================================================
//  👑 ADMIN CONFIG
// ================================================================
const ADMIN_PHONE_NUMBER = "94762513957";
const ADMIN_LID = "178481912627279";
const ADMIN_JIDS = [`${ADMIN_LID}@lid`];

function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    if (normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`) return true;
    if (ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID))) return true;
    return sender.includes(ADMIN_PHONE_NUMBER);
}

// ================================================================
//  📚 KNOWLEDGE BASE
// ================================================================
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json');
let knowledgeBase = [];
try {
    if (fs.existsSync(KNOWLEDGE_FILE)) knowledgeBase = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
} catch (e) { console.error('Error loading knowledge.json:', e); }

function saveKnowledgeBase() {
    try { fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeBase, null, 2)); } catch (e) { console.error(e); }
}

function buildPromptWithKnowledge(basePrompt) {
    if (knowledgeBase.length === 0) return basePrompt;
    const knowledgeText = knowledgeBase.map((k, i) => `${i+1}. ${k}`).join('\n');
    return `${basePrompt}\n\n[BATCH-SPECIFIC KNOWLEDGE — use if relevant:]\n${knowledgeText}`;
}

// ================================================================
//  📚 ACADEMIC WORD LIST (Full List 1-8 with Simple Meanings)
// ================================================================
const academicWords = {
    // --- List 1 ---
    "estimate": "To guess the amount or value of something.",
    "period": "A length of time.",
    "analysis": "Looking at something carefully to understand it.",
    "evidence": "Facts that prove something is true.",
    "policy": "A plan or rule.",
    "approach": "A way of doing something.",
    "export": "To send goods to another country.",
    "principle": "A basic rule or belief.",
    "area": "A particular subject or place.",
    "factors": "Things that cause something to happen.",
    "procedure": "A series of steps.",
    "assessment": "Judging the quality or amount of something.",
    "financial": "Related to money.",
    "process": "A series of actions.",
    "assume": "To think something is true without proof.",
    "formula": "A mathematical rule.",
    "required": "Needed or necessary.",
    "authority": "The power or right to give orders.",
    "function": "The purpose of something.",
    "research": "To study and find out.",
    "available": "Ready to be used or obtained.",
    "identified": "Recognized or found.",
    "response": "An answer.",
    "benefit": "A helpful or good effect.",
    "income": "Money earned.",
    "role": "The job or function of someone.",
    "concept": "An idea.",
    "indicates": "Shows or points out.",
    "section": "A part of something.",
    "consistent": "Staying the same.",
    "individual": "One person.",
    "sector": "A part of the economy.",
    "constitutional": "Related to the basic laws of a country.",
    "interpretation": "Explaining the meaning.",
    "significant": "Important.",
    "context": "The situation in which something happens.",
    "involved": "Included or affected.",
    "similar": "Almost the same.",
    "contract": "A legal agreement.",
    "issue": "An important topic or problem.",
    "source": "Where something comes from.",
    "create": "To make something new.",
    "labour": "Work, especially physical work.",
    "specific": "Precise or exact.",
    "data": "Facts or information.",
    "legal": "Related to law.",
    "structure": "The way something is built.",
    "definition": "Explaining the meaning of a word.",
    "legislation": "Laws made by the government.",
    "theory": "An idea explaining something.",
    "derived": "Got from something else.",
    "major": "Important or big.",
    "variables": "Things that can change.",
    "distribution": "How something is spread out.",
    "method": "A way of doing something.",
    "economic": "Related to money and trade.",
    "occur": "To happen.",
    "environment": "The world around us.",
    "percent": "Out of a hundred.",
    "established": "Started or created.",
    // --- List 2 onwards (ඔයාගේ සම්පූර්ණ list එක මෙතනින් යනවා) ---
    "design": "A plan or drawing.",
    "potential": "Possible ability.",
    "achieve": "To succeed in doing something.",
    "distinction": "A clear difference.",
    "previous": "Happening before.",
    "acquisition": "Getting something.",
    "elements": "Basic parts.",
    "primary": "Main or most important.",
    "administration": "Managing or organizing.",
    "equation": "A mathematical statement.",
    "purchase": "To buy.",
    "affect": "To change or influence.",
    "evaluation": "Judging the value.",
    "range": "A set of different things.",
    "appropriate": "Suitable or right.",
    "features": "Important parts or qualities.",
    "region": "An area.",
    "aspects": "Parts of a subject.",
    "final": "Last or ending.",
    "regulations": "Official rules.",
    "assistance": "Help.",
    "focus": "To give attention to.",
    "relevant": "Connected to what is being discussed.",
    "categories": "Groups or types.",
    "impact": "A strong effect.",
    "resident": "Someone living in a place.",
    "chapter": "A section of a book.",
    "injury": "Damage or harm.",
    "resources": "Things that can be used.",
    "commission": "A special group or fee.",
    "institute": "A school or organization.",
    "restricted": "Limited.",
    "community": "People living in the same area.",
    "investment": "Putting money into something.",
    "security": "Safety.",
    "complex": "Hard to understand.",
    "items": "Individual objects.",
    "sought": "Looked for.",
    "computer": "An electronic machine.",
    "journal": "A magazine or diary.",
    "select": "To choose.",
    "conclusion": "A final decision.",
    "maintenance": "Keeping something in good condition.",
    "site": "A place.",
    "conduct": "To do or manage.",
    "normal": "Usual or standard.",
    "strategies": "Plans to achieve goals.",
    "consequences": "Results of an action.",
    "obtained": "Got or gained.",
    "survey": "A study or poll.",
    "construction": "Building something.",
    "participation": "Taking part in something.",
    "text": "Written words.",
    "consumer": "A person who buys things.",
    "perceived": "Noticed or understood.",
    "traditional": "Based on old customs.",
    "credit": "Money or praise.",
    "positive": "Good or sure.",
    "transfer": "To move from one place to another.",
    "cultural": "Related to customs and beliefs.",
    "alternative": "Another choice.",
    "circumstances": "The situations or conditions.",
    "comments": "Remarks or opinions.",
    "compensation": "Money paid for a loss.",
    "components": "Parts of a whole.",
    "consent": "Permission.",
    "considerable": "Large in amount.",
    "constant": "Staying the same.",
    "constraints": "Limitations.",
    "contribution": "Giving or helping.",
    "convention": "A formal meeting or custom.",
    "coordination": "Organizing things together.",
    "core": "The central or most important part.",
    "corporate": "Related to a company.",
    "corresponding": "Matching or related.",
    "criteria": "Standards used for judging.",
    "deduction": "Subtracting or concluding.",
    "demonstrate": "To show clearly.",
    "document": "A written record.",
    "dominant": "Most powerful or important.",
    "emphasis": "Special importance.",
    "ensure": "To make sure.",
    "excluded": "Left out.",
    "framework": "A basic structure.",
    "funds": "Money.",
    "illustrated": "Shown with pictures or examples.",
    "immigration": "Moving to a country to live.",
    "implies": "Suggests without saying.",
    "initial": "First.",
    "instance": "An example.",
    "interaction": "Communication or contact.",
    "justification": "A good reason.",
    "layer": "A level or sheet.",
    "link": "A connection.",
    "location": "A place.",
    "maximum": "The highest amount.",
    "minorities": "Smaller groups in a society.",
    "negative": "Bad or harmful.",
    "outcomes": "Results.",
    "partnership": "A relationship between people.",
    "philosophy": "The study of ideas and life.",
    "physical": "Related to the body or things.",
    "proportion": "A part or share of a whole.",
    "published": "Printed or made public.",
    "reaction": "A response.",
    "registered": "Officially recorded.",
    "reliance": "Dependence on something.",
    "removed": "Taken away.",
    "scheme": "A plan or system.",
    "sequence": "The order of things.",
    "sex": "Gender.",
    "shift": "A change.",
    "specified": "Clearly stated.",
    "sufficient": "Enough.",
    "task": "A piece of work.",
    "technical": "Related to practical skills or machines.",
    "techniques": "Methods of doing something.",
    "technology": "Machines and tools.",
    "validity": "Being true or legal.",
    "volume": "Amount or level.",
    "access": "The right to enter or use.",
    "adequate": "Enough.",
    "annual": "Happening once a year.",
    "apparent": "Seeming to be true.",
    "approximated": "Roughly calculated.",
    "attitudes": "Ways of thinking.",
    "attributed": "Believed to be caused by.",
    "civil": "Related to citizens.",
    "code": "A system of rules.",
    "commitment": "A promise or dedication.",
    "communication": "Sharing information.",
    "concentration": "Focus or amount.",
    "conference": "A formal meeting.",
    "contrast": "A clear difference.",
    "cycle": "A repeating sequence.",
    "debate": "A formal discussion.",
    "despite": "Even though.",
    "dimensions": "Measurements or aspects.",
    "domestic": "Related to home or country.",
    "emerged": "Came out or appeared.",
    "error": "A mistake.",
    "ethnic": "Related to race or culture.",
    "goals": "Things you want to achieve.",
    "granted": "Given or allowed.",
    "hence": "Therefore.",
    "hypothesis": "An idea to be tested.",
    "implementation": "Putting a plan into action.",
    "implications": "Possible effects.",
    "imposed": "Forced.",
    "integration": "Joining together.",
    "internal": "Inside.",
    "investigation": "An official search for facts.",
    "job": "Work or task.",
    "label": "A tag or name.",
    "mechanism": "A system or process.",
    "obvious": "Clear and easy to see.",
    "occupational": "Related to work.",
    "option": "A choice.",
    "output": "The amount produced.",
    "overall": "In general.",
    "parallel": "Similar and happening at the same time.",
    "parameters": "Limits or rules.",
    "phase": "A stage.",
    "predicted": "Said what will happen.",
    "principal": "Main or head.",
    "prior": "Before.",
    "professional": "Related to a job or expert.",
    "project": "A planned piece of work.",
    "promote": "To support or raise.",
    "regime": "A system of government.",
    "resolution": "A solution or decision.",
    "retained": "Kept.",
    "series": "A number of things in a row.",
    "statistics": "Numbers that show facts.",
    "status": "Position or condition.",
    "stress": "Pressure or worry.",
    "subsequent": "Coming after.",
    "sum": "Total amount.",
    "summary": "A short version.",
    "undertaken": "Started or agreed to do.",
    "academic": "Related to education and study.",
    "adjustment": "A small change.",
    "alter": "To change.",
    "amendment": "A change to a law or document.",
    "aware": "Knowing about something.",
    "capacity": "The ability or amount.",
    "challenge": "A difficult task.",
    "clause": "A part of a legal document.",
    "compounds": "Things made of two or more parts.",
    "conflict": "A disagreement.",
    "consultation": "Asking for advice.",
    "contact": "Communication or touching.",
    "decline": "To go down or refuse.",
    "discretion": "The freedom to decide.",
    "draft": "A first version.",
    "enable": "To make possible.",
    "energy": "Power to do work.",
    "enforcement": "Making sure rules are followed.",
    "entities": "Things that exist.",
    "equivalent": "Equal in value.",
    "evolution": "Gradual change over time.",
    "expansion": "Growing larger.",
    "exposure": "Being open to something.",
    "external": "Outside.",
    "facilitate": "To make easier.",
    "fundamental": "Basic and important.",
    "generated": "Produced.",
    "generation": "A group born around the same time.",
    "image": "A picture.",
    "liberal": "Open to new ideas.",
    "licence": "Official permission.",
    "logic": "Reasonable thinking.",
    "marginal": "Small or not important.",
    "medical": "Related to health.",
    "mental": "Related to the mind.",
    "modified": "Changed.",
    "monitoring": "Watching or checking.",
    "network": "A system of connected things.",
    "notion": "An idea.",
    "objective": "A goal or based on facts.",
    "orientation": "Direction or training.",
    "perspective": "A point of view.",
    "precise": "Exact.",
    "prime": "Main or most important.",
    "psychology": "The study of the mind.",
    "pursue": "To follow or chase.",
    "ratio": "A relationship between two numbers.",
    "rejected": "Refused.",
    "revenue": "Money earned.",
    "stability": "Being steady.",
    "styles": "Ways of doing something.",
    "substitution": "Replacing one thing with another.",
    "sustainable": "Able to continue without harm.",
    "symbolic": "Representing something.",
    "target": "A goal to hit.",
    "transition": "A change from one state to another.",
    "trend": "A general direction.",
    "version": "A form of something.",
    "welfare": "Health and happiness.",
    "whereas": "While on the other hand.",
    "abstract": "A short summary or not concrete.",
    "accurate": "Correct and exact.",
    "acknowledged": "Recognized or admitted.",
    "aggregate": "A total formed by adding.",
    "allocation": "Sharing out.",
    "assigned": "Given a task.",
    "attached": "Connected or joined.",
    "author": "The writer of a book.",
    "bond": "A connection or agreement.",
    "brief": "Short in time or length.",
    "capable": "Having the ability.",
    "cited": "Quoted as proof.",
    "cooperative": "Working together.",
    "discrimination": "Treating people unfairly.",
    "display": "To show.",
    "diversity": "Variety of different things.",
    "domain": "An area of knowledge or control.",
    "edition": "A version of a book.",
    "enhanced": "Improved.",
    "estate": "Property or land.",
    "exceed": "To go beyond a limit.",
    "expert": "A person with special skills.",
    "explicit": "Clear and direct.",
    "federal": "Related to the central government.",
    "fees": "Money paid for a service.",
    "flexibility": "Able to change easily.",
    "furthermore": "Also.",
    "gender": "Being male or female.",
    "ignored": "Paid no attention to.",
    "incentive": "Something that motivates.",
    "incidence": "How often something happens.",
    "incorporated": "Included as a part.",
    "index": "A list or guide.",
    "inhibition": "A feeling of worry that stops action.",
    "initiatives": "New plans or actions.",
    "input": "What is put in.",
    "instructions": "Orders or directions.",
    "intelligence": "The ability to learn and understand.",
    "interval": "A gap in time.",
    "lecture": "A talk given to a class.",
    "migration": "Moving from one place to another.",
    "minimum": "The smallest amount.",
    "ministry": "A government department.",
    "motivation": "A reason to do something.",
    "neutral": "Not taking sides.",
    "nevertheless": "Despite that.",
    "overseas": "In a foreign country.",
    "preceding": "Coming before.",
    "presumption": "Something assumed.",
    "rational": "Based on reason.",
    "recovery": "Getting better after an illness.",
    "revealed": "Shown or made known.",
    "scope": "The range of something.",
    "subsidiary": "A smaller company controlled by another.",
    "tapes": "Recordings.",
    "trace": "A mark or sign left behind.",
    "transformation": "A complete change.",
    "transport": "Moving goods or people.",
    "underlying": "Lying beneath or fundamental.",
    "utility": "Usefulness.",
    "adaptation": "Changing to fit a new situation.",
    "adults": "Grown-up people.",
    "advocate": "To support publicly.",
    "aid": "Help.",
    "channel": "A way of transmitting or moving.",
    "chemical": "A substance used in science.",
    "classical": "Traditional or relating to ancient times.",
    "comprehensive": "Complete and covering everything.",
    "comprise": "To consist of.",
    "confirmed": "Proved to be true.",
    "contrary": "Opposite.",
    "converted": "Changed.",
    "couple": "Two things or people.",
    "decades": "Periods of ten years.",
    "definite": "Clear and certain.",
    "deny": "To say something is not true.",
    "differentiation": "Seeing or making a difference.",
    "disposal": "Getting rid of something.",
    "dynamic": "Active and changing.",
    "eliminate": "To remove completely.",
    "empirical": "Based on observation or experience.",
    "equipment": "Tools needed for a task.",
    "extract": "To pull out.",
    "file": "A collection of papers or data.",
    "finite": "Having a limit.",
    "foundation": "The base of something.",
    "global": "Worldwide.",
    "grade": "A level or mark.",
    "guarantee": "A promise that something will happen.",
    "hierarchical": "Organized in levels.",
    "identical": "Exactly the same.",
    "ideology": "A set of beliefs.",
    "inferred": "Concluded from evidence.",
    "innovation": "A new idea or method.",
    "insert": "To put in.",
    "intervention": "Action to change something.",
    "isolated": "Separated from others.",
    "media": "Channels of communication.",
    "mode": "A way of doing something.",
    "paradigm": "A model or pattern.",
    "phenomenon": "An observable fact or event.",
    "priority": "Something more important.",
    "prohibited": "Forbidden.",
    "publication": "A printed book or article.",
    "quotation": "Words repeated from a source.",
    "release": "To set free or make public.",
    "reverse": "To change to the opposite.",
    "simulation": "An imitation of a real situation.",
    "solely": "Only.",
    "somewhat": "To some degree.",
    "submitted": "Sent in for consideration.",
    "successive": "Coming one after another.",
    "survive": "To continue to live.",
    "thesis": "A long piece of writing.",
    "topic": "A subject.",
    "transmission": "The process of passing on.",
    "ultimately": "Finally.",
    "unique": "One of a kind.",
    "visible": "Able to be seen.",
    "voluntary": "Done by choice.",
    "abandon": "To leave completely.",
    "development": "Growth or progress.",
    "plus": "And also.",
    "accompanied": "Went with.",
    "displacement": "Moving from a place.",
    "practitioners": "People who do a particular job.",
    "accumulation": "Collecting more over time.",
    "dramatic": "Sudden and big.",
    "predominantly": "Mainly.",
    "ambiguous": "Unclear.",
    "eventually": "In the end.",
    "prospect": "The possibility of something.",
    "appendix": "Extra material at the end of a book.",
    "exhibit": "To show publicly.",
    "radical": "Extreme or fundamental.",
    "appreciation": "Understanding or enjoying.",
    "exploitation": "Using something unfairly.",
    "random": "By chance.",
    "arbitrary": "Based on chance, not reasons.",
    "fluctuations": "Ups and downs.",
    "reinforced": "Made stronger.",
    "automatically": "Without human control.",
    "guidelines": "Advice or rules.",
    "restore": "To bring back.",
    "bias": "An unfair preference.",
    "highlighted": "Emphasized or pointed out.",
    "revision": "A change or review.",
    "chart": "A diagram or graph.",
    "implicit": "Suggested but not said.",
    "schedule": "A plan of times.",
    "clarity": "Clearness.",
    "induced": "Caused.",
    "tension": "Stress or pressure.",
    "conformity": "Following rules or standards.",
    "inevitably": "Certain to happen.",
    "termination": "Ending.",
    "commodity": "A product that can be bought or sold.",
    "infrastructure": "Basic systems like roads and power.",
    "theme": "The main subject.",
    "complement": "To go well with.",
    "inspection": "Looking at closely.",
    "thereby": "By that means.",
    "contemporary": "Modern or current.",
    "intensity": "Strength.",
    "uniform": "Same in all cases.",
    "contradiction": "A conflict in information.",
    "manipulation": "Controlling something cleverly.",
    "vehicle": "A machine for carrying things.",
    "crucial": "Very important.",
    "minimised": "Made as small as possible.",
    "via": "Through or by way of.",
    "currency": "Money.",
    "nuclear": "Related to the core of an atom.",
    "virtually": "Almost.",
    "denote": "To mean or represent.",
    "offset": "To balance.",
    "widespread": "Existing in many places.",
    "detected": "Noticed or found.",
    "paragraph": "A part of writing.",
    "visual": "Related to seeing."
};

// ================================================================
//  📇 STUDENT REGISTRY (Welcome Message Logic එකත් එක්ක)
// ================================================================
const STUDENTS_FILE = path.join(__dirname, 'students.json');
let studentRegistry = [];
try {
    if (fs.existsSync(STUDENTS_FILE)) studentRegistry = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
} catch (e) { console.error('Error loading students.json:', e); }

function saveStudents() {
    try { fs.writeFileSync(STUDENTS_FILE, JSON.stringify(studentRegistry, null, 2)); } catch (e) { console.error(e); }
}

function addStudent(jid) {
    if (!studentRegistry.includes(jid)) {
        studentRegistry.push(jid);
        saveStudents();
        console.log('📇 New student registered:', jid);
        return true; // ✅ අලුත් කෙනෙක් නම් True
    }
    return false; // ✅ දැනටමත් ඉන්න කෙනෙක් නම් False
}

let geminiRequestsToday = 0;

// ================================================================
//  📁 FILE REGISTRY
// ================================================================
const FILES_DIR = path.join(__dirname, 'resources');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
const FILE_REGISTRY_PATH = path.join(__dirname, 'files-registry.json');
let fileRegistry = [];
try {
    if (fs.existsSync(FILE_REGISTRY_PATH)) fileRegistry = JSON.parse(fs.readFileSync(FILE_REGISTRY_PATH, 'utf8'));
} catch (e) { console.error('Error loading files-registry.json:', e); }

function saveFileRegistry() {
    try { fs.writeFileSync(FILE_REGISTRY_PATH, JSON.stringify(fileRegistry, null, 2)); } catch (e) { console.error(e); }
}

// ================================================================
//  🧵 CONCURRENCY QUEUE
// ================================================================
const MAX_CONCURRENT = 3;
class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }
    add(task, onQueued) {
        return new Promise((resolve, reject) => {
            const willWait = this.running >= this.concurrency;
            this.queue.push({ task, resolve, reject });
            if (willWait && typeof onQueued === 'function') onQueued(this.queue.length);
            this._next();
        });
    }
    _next() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        const { task, resolve, reject } = this.queue.shift();
        this.running++;
        task().then(resolve).catch(reject).finally(() => {
            this.running--;
            this._next();
        });
    }
}
const messageQueue = new ConcurrencyQueue(MAX_CONCURRENT);

// ================================================================
//  🧠 CONVERSATION MEMORY
// ================================================================
const userMemory = {};

function getRecentContext(userId) {
    const history = userMemory[userId];
    if (!history || history.length === 0) return "";
    return history.map(msg => `${msg.role}: ${msg.text}`).join("\n");
}

function addToMemory(userId, role, text) {
    if (!userMemory[userId]) userMemory[userId] = [];
    userMemory[userId].push({ role, text });
    if (userMemory[userId].length > 10) { 
        userMemory[userId].shift();
    }
}

// ================================================================
//  🔁 MESSAGE DEDUP
// ================================================================
const processedMessages = new Set();
const MAX_TRACKED_MESSAGES = 1000;
function markProcessed(id) {
    processedMessages.add(id);
    if (processedMessages.size > MAX_TRACKED_MESSAGES) {
        const oldest = processedMessages.values().next().value;
        processedMessages.delete(oldest);
    }
}

// ================================================================
//  🚀 EXPRESS WEB SERVER
// ================================================================
const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = "";
let isConnected = false;

// ================================================================
//  🛡️ RATE LIMIT & ANTI-SPAM (Memory Leak Fix එක ඇතුළත්)
// ================================================================
const rateLimitMap = {}; 

// ⏰ Memory Leak Fix - පැය 1කට සැරයක් පරණ Data හිස් කිරීම
setInterval(() => {
    const now = Date.now();
    for (const userId in rateLimitMap) {
        if (now - rateLimitMap[userId].startTime > 3600000) {
            delete rateLimitMap[userId];
        }
    }
}, 3600000);

function checkRateLimit(userId) {
    const now = Date.now();
    const user = rateLimitMap[userId] || { count: 0, startTime: now, blockedUntil: 0 };

    if (now < user.blockedUntil) {
        return { allowed: false, reason: `⚠️ Spam එක නවත්තන්න! තත්පර ${Math.ceil((user.blockedUntil - now) / 1000)}ක් ඉන්න.` };
    }

    if (now - user.startTime > 5000) {
        user.count = 0;
        user.startTime = now;
    }

    user.count++;
    rateLimitMap[userId] = user;

    if (user.count > 5) {
        user.blockedUntil = now + 60000;
        rateLimitMap[userId] = user;
        return { allowed: false, reason: "⚠️ ඕනෑවට වඩා ඉක්මනට Messages යවනවා. තත්පර 60ක් රැඳී සිටින්න." };
    }

    return { allowed: true, reason: "" };
}

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`<html><head><title>HansanaBot — Connected</title><meta http-equiv="refresh" content="30"></head>
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
            <h2 style="color:#2ea043;">✅ Bot එක Connected & Running!</h2>
            <p style="color:#58a6ff;">WhatsApp Bot එක සාර්ථකව Connect වෙලා!</p>
            <p style="color:#8b949e;">ඔබට Bot එකට DM කරලා Test කරන්න පුළුවන්.</p>
            <p style="color:#8b949e;font-size:12px;margin-top:30px;">Page එක තත්පර 30කට වතාවක් Auto Refresh වෙයි</p>
            </body></html>`);
    }
    if (!latestQR) {
        return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
            <h2 style="color:#f0883e;">⏳ QR Code එක Loading...</h2>
            <p style="color:#8b949e;">තත්පර 3න් Auto Refresh වෙයි</p>
            </body></html>`);
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`<html><head><title>WhatsApp Bot QR</title><meta http-equiv="refresh" content="15"></head>
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0d1117;color:white;">
            <h2 style="color:#58a6ff;">📱 Scan this QR Code with WhatsApp</h2>
            <img src="${qrImage}" style="border:10px solid white;border-radius:10px;width:300px;height:300px;"/>
            <p style="color:#8b949e;margin-top:20px;">QR Code එක Scan කරලා Bot එක Connect කරන්න</p>
            <p style="color:#8b949e;font-size:14px;">Page එක තත්පර 15කට වතාවක් Auto Refresh වෙයි</p>
            </body></html>`);
    } catch (err) {
        res.status(500).send('Error generating QR code');
    }
});

app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ================================================================
//  🤖 GEMINI SETUP
// ================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY not set. Exiting.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const systemInstruction = `You are HansanaBot... [System Prompt]`;

const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite", 
    systemInstruction: systemInstruction
});

function formatMathForWhatsApp(text) { ... }
async function getCalendarIntentFromAI(text) { ... }
function cleanHTML(text) { ... }

// ================================================================
//  📅 CALENDAR READER
// ================================================================
// ... (getTargetDateRange, getCalendarEvents, sendDailyTimetable)

// ================================================================
//  🎵 AUDIO CONVERSION
// ================================================================
// ... (convertAudioToMp3)

// ================================================================
//  💬 MAIN MESSAGE PROCESSING
// ================================================================
async function connectToWhatsApp() {
    // ... (Socket setup, Cron Jobs)

    async function processMessage(sock, msg) {
        const sender = msg.key.remoteJid;

        // 🚨 අලුත් Student කෙනෙක් නම් Welcome Message එකක් (User-Friendly)
        const isNewUser = addStudent(sender);
        if (isNewUser) {
            await sock.sendMessage(sender, { text: "🙌 ආයුබෝවන්! මම *HansanaBot*, ඔයාගේ AI සහායකයා! 👋\n\n*help* කියලා type කරලා මම කරන දේවල් බලන්න. 🚀" }, { quoted: msg });
        }

        const rateCheck = checkRateLimit(sender);
        if (!rateCheck.allowed) { ... }

        // ... (Commands: Status, Add Info, AI Intent, Whoami, Help, etc.)

        // 🎉 FUN & MOTIVATION
        if (textLower === 'motivate me' || textLower === 'daily quote' || textLower === 'inspire me') {
            const quotes = [
                "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",
                "Don't watch the clock; do what it does. Keep going. - Sam Levenson",
                "The secret of getting ahead is getting started. - Mark Twain",
                "It always seems impossible until it's done. - Nelson Mandela",
                "Bestie, just focus on your goals. No cap, you got this! 🔥"
            ];
            const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
            await sock.sendMessage(sender, { text: `✨ *Motivation:*\n\n"${randomQuote}"` }, { quoted: msg });
            return;
        }
        if (textLower === 'riddle') {
            global.currentRiddle = "I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?";
            await sock.sendMessage(sender, { text: `🧩 *Riddle:*\n\n${global.currentRiddle}` }, { quoted: msg });
            return;
        }
        if (textLower === 'answer' && global.currentRiddle) {
            await sock.sendMessage(sender, { text: "✅ The answer is: **An Echo**! 🎉" }, { quoted: msg });
            global.currentRiddle = null;
            return;
        }

        // 📖 ACADEMIC WORD PRACTICE
        if (textLower === 'word' || textLower === 'aw word' || textLower === 'practice word' || textLower === 'vocabulary') {
            const wordKeys = Object.keys(academicWords);
            const randomWord = wordKeys[Math.floor(Math.random() * wordKeys.length)];
            const wordMeaning = academicWords[randomWord];
            await sock.sendMessage(sender, { text: `📚 *Academic Word Practice*\n\n*${randomWord}*\n📖 Meaning: ${wordMeaning}\n\nType *word* again to get another one! 🔄` }, { quoted: msg });
            return;
        }

        // 🗳️ POLL SYSTEM
        if (textLower.startsWith('create poll')) {
            if (!isSenderAdmin(sender)) return;
            const pollQuestion = rawMessageText.replace(/^create poll\s*:?\s*/i, '').trim();
            if (!pollQuestion) return;
            global.activePoll = { question: pollQuestion, votes: { '1': 0, '2': 0 } };
            await sock.sendMessage(sender, { text: `📊 *Poll Created!*\n\n${pollQuestion}\n\nType *vote 1* or *vote 2* to vote!` }, { quoted: msg });
            return;
        }
        if (textLower === 'vote 1' || textLower === 'vote 2') {
            if (!global.activePoll) return;
            const choice = textLower === 'vote 1' ? '1' : '2';
            global.activePoll.votes[choice]++;
            await sock.sendMessage(sender, { text: `✅ Your vote for *${choice}* is recorded!` }, { quoted: msg });
            return;
        }
        if (textLower === 'poll results' && isSenderAdmin(sender)) {
            if (!global.activePoll) return;
            const { question, votes } = global.activePoll;
            const total = votes['1'] + votes['2'];
            const p1 = total > 0 ? Math.round((votes['1'] / total) * 100) : 0;
            const p2 = total > 0 ? Math.round((votes['2'] / total) * 100) : 0;
            await sock.sendMessage(sender, { text: `📊 *Results: ${question}*\n\n1️⃣ Option 1: ${votes['1']} (${p1}%)\n2️⃣ Option 2: ${votes['2']} (${p2}%)` }, { quoted: msg });
            return;
        }

        // 👥 STUDENT REGISTRATION
        if (textLower.startsWith('register')) {
            const data = rawMessageText.replace(/^register\s*:?\s*/i, '').trim();
            if (!data) return;
            const parts = data.split(' - ').map(s => s.trim());
            if (parts.length < 2) {
                await sock.sendMessage(sender, { text: "⚠️ Format: *register: 20210033 - Kasun - G1*" }, { quoted: msg });
                return;
            }
            const studentRecord = { jid: sender, id: parts[0], name: parts[1], group: parts[2] || 'N/A' };
            if (!studentRegistry.some(s => s.jid === sender)) {
                studentRegistry.push(studentRecord);
                saveStudents();
                await sock.sendMessage(sender, { text: `✅ Registered! Welcome *${studentRecord.name}* (${studentRecord.id})!` }, { quoted: msg });
            } else {
                await sock.sendMessage(sender, { text: "ℹ️ You are already registered!" }, { quoted: msg });
            }
            return;
        }
        if (textLower === 'list students' && isSenderAdmin(sender)) {
            if (studentRegistry.length === 0) return await sock.sendMessage(sender, { text: "No students registered yet." }, { quoted: msg });
            const list = studentRegistry.map((s, i) => `${i+1}. ${s.name} (${s.id}) - ${s.group}`).join('\n');
            await sock.sendMessage(sender, { text: `👥 *Registered Students (${studentRegistry.length})*\n\n${list}` }, { quoted: msg });
            return;
        }

        // 📅 ASSIGNMENT TRACKER
        if (textLower.startsWith('add assignment') && isSenderAdmin(sender)) {
            const taskText = rawMessageText.replace(/^add assignment\s*:?\s*/i, '').trim();
            if (!taskText) return;
            if (!global.assignments) global.assignments = [];
            global.assignments.push(taskText);
            await sock.sendMessage(sender, { text: `✅ Assignment Added! (Total: ${global.assignments.length})` }, { quoted: msg });
            return;
        }
        if (textLower === 'assignments' || textLower === 'tasks') {
            if (!global.assignments || global.assignments.length === 0) {
                await sock.sendMessage(sender, { text: "🎉 No pending assignments right now!" }, { quoted: msg });
            } else {
                await sock.sendMessage(sender, { text: `📝 *Assignments/Deadlines:*\n\n${global.assignments.map((a, i) => `${i+1}. ${a}`).join('\n')}` }, { quoted: msg });
            }
            return;
        }
        if (textLower.startsWith('remove assignment') && isSenderAdmin(sender)) {
            const idx = parseInt(textLower.replace('remove assignment', '').trim()) - 1;
            if (global.assignments && global.assignments[idx]) {
                const removed = global.assignments.splice(idx, 1)[0];
                await sock.sendMessage(sender, { text: `🗑️ Removed: ${removed}` }, { quoted: msg });
            }
            return;
        }

        // 🙏 THANKS AUTO-REPLY
        if (textLower.includes('thanks') || textLower.includes('thank you') || textLower.includes('sthuthi') || textLower.includes('stuti') || textLower.includes('bohoma sthuthi')) {
            await sock.sendMessage(sender, { text: "ඔයාව සාදරයෙන් පිළිගන්නවා! 🥰❤️ තව මොනවා හරි ඕන නම් අහන්න!" }, { quoted: msg });
            return;
        }

        // ---------- GENERAL AI RESPONSE ----------
        // ...
    }

    // ... messages.upsert
}
connectToWhatsApp();
