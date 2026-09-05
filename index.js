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
const GROUP_JID = process.env.GROUP_JID; 

function isSenderAdmin(sender) {
    const normalized = jidNormalizedUser(sender) || sender;
    if (ADMIN_JIDS.includes(sender) || ADMIN_JIDS.includes(normalized)) return true;
    if (normalized === `${ADMIN_PHONE_NUMBER}@s.whatsapp.net`) return true;
    if (ADMIN_LID && (normalized === `${ADMIN_LID}@lid` || sender.includes(ADMIN_LID))) return true;
    return sender.includes(ADMIN_PHONE_NUMBER);
}

// ================================================================
//  📁 DATA DIRECTORY (Volume Path)
// ================================================================
const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ================================================================
//  📚 KNOWLEDGE BASE
// ================================================================
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
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
//  📚 ACADEMIC WORD LIST
// ================================================================
const academicWords = {
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
//  📇 STUDENT REGISTRY
// ================================================================
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
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
        return true;
    }
    return false;
}

let geminiRequestsToday = 0;

// ================================================================
//  📁 FILE REGISTRY
// ================================================================
const FILES_DIR = path.join(DATA_DIR, 'resources');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
const FILE_REGISTRY_PATH = path.join(DATA_DIR, 'files-registry.json');
let fileRegistry = [];
try {
    if (fs.existsSync(FILE_REGISTRY_PATH)) fileRegistry = JSON.parse(fs.readFileSync(FILE_REGISTRY_PATH, 'utf8'));
} catch (e) { console.error('Error loading files-registry.json:', e); }

function saveFileRegistry() {
    try { fs.writeFileSync(FILE_REGISTRY_PATH, JSON.stringify(fileRegistry, null, 2)); } catch (e) { console.error(e); }
}

// ================================================================
//  📚 MODULE TO FILE KEYWORD MAPPING (for quiz)
// ================================================================
const MODULE_FILE_MAP = {
    'SE1020': ['oop', 'se1020', 'object oriented'],
    'IT1170': ['dsa', 'it1170', 'data structures'],
    'IT1160': ['discrete', 'it1160', 'math'],
    'IT1150': ['technical writing', 'it1150', 'writing'],
    'IE1011': ['information systems', 'ie1011', 'is']
};

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
//  🧠 CONVERSATION MEMORY & LAST FILE CONTEXT
// ================================================================
const userMemory = {};
const lastFileContext = {};

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
//  🛡️ RATE LIMIT & ANTI-SPAM
// ================================================================
const rateLimitMap = {}; 

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
const apiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4
].filter(key => key); 

let currentKeyIndex = 0;

function getNextGenAI() {
    if (apiKeys.length === 0) {
        console.error('❌ No API keys found! Please set GEMINI_API_KEY_1...');
        process.exit(1);
    }
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length; 
    return new GoogleGenerativeAI(key);
}

const systemInstruction = `
You are HansanaBot, the official digital assistant representing the SLIIT IT Y1S2 Batch Representative, Monal Hansana.

YOUR PERSONALITY & TONE:
- Your tone must ALWAYS be professional, helpful, polite, and warm.
- Address students respectfully (e.g., "ඔබට", "ඔයාට").
- Provide neatly formatted answers (use bullet points and bold text).
- NEVER give random, unrelated, or excessively long raw information. Always answer the specific question asked by the student.

RULES FOR KNOWLEDGE BASE:
- When you have information in your Knowledge Base (add info), give exactly the requested details in a structured, clean manner.
- If the info is about Fees, Dates, LIC, or Links, present them clearly so the student understands instantly.

BATCH REPRESENTATIVE (MONAL HANSANA) CONTACT DETAILS:
- When students ask for Batch Rep's contact details, phone number, email, or how to contact Monal, provide these details cleanly:
  * Name: Monal Hansana (SLIIT IT Y1S2 Batch Representative)
  * Contact Number: +94 76 251 3957 (076 251 3957)
  * Official SLIIT Email: it26100930@my.sliit.lk

Y1S2 MODULE DETAILS & LIC INFORMATION (Use this when asked):
1. IT1170 - DSA -> LIC: Prof. Nathali Silva (nathali.s@sliit.lk)
2. IT1160 - Discrete Math -> LIC: Ms. Nipuni Maleesha (nipuni.m@sliit.lk)
3. SE1020 - OOP -> LIC: Ms. Thilini Jayalath (thilini.j@sliit.lk)
4. IT1150 - Technical Writing -> LIC: Ms. Dinushika Jayathissa (dinushika.j@sliit.lk)
5. IE1011 - Information Systems -> LIC: Ms. Chathurangika Kahandawarachchi (chathurangika.k@sliit.lk)

ACADEMIC & UNIVERSITY RULES:
- Minimum 80% attendance is strictly required to sit for final exams.
- Grade is based on Continuous Assessments + Final Exam.
- Lab Group Switching requires prior LIC approval.

IMPORTANT LINKS:
1. Timetable / Calendar: https://calendar.google.com/calendar/u/0?cid=Y2EwYjM4ZDE3MjcyOTIzMTY1N2FiZmMzNGYxYzdmZGJmOGVhMzMwNTBmZTZmNDYyM2Y1ZmFiODhjMGQzNDYzM0Bncm91cC5jYWxlbmRhci5nb29nbGUuY29t
2. Courseweb (LMS): https://courseweb.sliit.lk/
3. Eduscope (Lecture Recordings): https://eduscope.sliit.lk/
4. Issue Reporting Form: https://docs.google.com/forms/d/e/1FAIpQLSfOUJnkMp8Tdig0C187WDOgU5AZmtPh3ayBZ-_z9xd23K3Zgw/viewform?usp=dialog
5. SLIIT Support Desk: https://ask.sliit.lk/

CRITICAL — NEVER CLAIM TO HAVE SENT/POSTED SOMETHING:
- You CANNOT actually send messages, post announcements, or perform any action outside this chat reply.
- NEVER say things like "I've sent this to the group" or "yawanawa" / "දැම්මා".
- If a user asks you to post/send something, explain that only the Batch Rep (Monal) can trigger that.

CRITICAL CODE & TUTORIAL ANALYSIS RULES:
- When analyzing code snippets or tutorials:
  1. Pay EXTREME attention to variable scope and re-initialization (e.g., whether 'j = 1' is initialized OUTSIDE or INSIDE an outer loop).
  2. Distinguish clearly between Sequential/Consecutive loops and Nested loops.
  3. Keep track of accurate question labeling (a, b, c, d, e) without swapping their code contents.
`;

// ✅ FIX: Valid Model Name (gemini-3.5-flash-lite)
let model = getNextGenAI().getGenerativeModel({
    model: "gemini-3.5-flash-lite", 
    systemInstruction: systemInstruction
});

function createModelWithCurrentKey() {
    return getNextGenAI().getGenerativeModel({
        model: "gemini-3.1-flash-lite", 
        systemInstruction: systemInstruction
    });
}

async function generateContentWithRetry(modelInstance, request, maxRetries = 4) {
    let delay = 1000; // 1 second initial delay

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await modelInstance.generateContent(request);
        } catch (error) {
            if (error.status === 503 || error.status === 429 || error.message.includes('503') || error.message.includes('429')) {
                if (attempt === maxRetries) {
                    console.error('Max retries reached. Switching keys failed too:', error.message);
                    throw error;
                }
                
                model = createModelWithCurrentKey();

                console.log(`Error ${error.status} detected. Switching to key #${currentKeyIndex} and retrying in ${delay/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff (1s, 2s, 4s, 8s)
            } else {
                throw error; // අනිත් errors (400, 401) වෙනුවෙන්
            }
        }
    }
}

function formatMathForWhatsApp(text) {
    if (!text) return text;
    const replacements = [
        [/\\cup/g, '∪'], [/\\cap/g, '∩'], [/\\in\b/g, '∈'], [/\\notin\b/g, '∉'],
        [/\\subseteq/g, '⊆'], [/\\subset/g, '⊂'], [/\\supseteq/g, '⊇'], [/\\supset/g, '⊃'],
        [/\\emptyset/g, '∅'], [/\\varnothing/g, '∅'], [/\\forall/g, '∀'], [/\\exists/g, '∃'],
        [/\\leq/g, '≤'], [/\\geq/g, '≥'], [/\\neq/g, '≠'], [/\\approx/g, '≈'],
        [/\\times/g, '×'], [/\\div/g, '÷'], [/\\pm/g, '±'], [/\\sqrt/g, '√'],
        [/\\infty/g, '∞'], [/\\rightarrow/g, '→'], [/\\to\b/g, '→'],
        [/\\Rightarrow/g, '⇒'], [/\\Leftrightarrow/g, '⇔'], [/\\sum/g, 'Σ'], [/\\int/g, '∫'],
        [/\\pi\b/g, 'π'], [/\\theta\b/g, 'θ'], [/\\alpha\b/g, 'α'], [/\\beta\b/g, 'β'],
        [/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1/$2'],
        [/\$\$?/g, ''], [/\\\(/g, ''], [/\\\)/g, ''], [/\\\[/g, ''], [/\\\]/g, '']
    ];
    let result = text;
    for (const [pattern, symbol] of replacements) result = result.replace(pattern, symbol);
    return result;
}

// AI Intent
async function getCalendarIntentFromAI(text) {
    const prompt = `
    You are a highly accurate intent classifier for a University WhatsApp Bot.
    Analyze the user's message below. The user is asking about their SLIIT timetable.
    Identify if they are asking for a schedule for a specific day ("ada", "heta", "anidda", "pereda", "monday", "september 3" etc.), or if they are just chatting.
    Rules:
    - ONLY classify as 'calendar' if they are asking for a class schedule.
    - If they are just chatting (e.g., "adaraya", "kohomada", "hello"), classify as 'chat'.
    - If they are saving info (starts with "Add info"), classify as 'add_info'.
    - Respond with ONLY a JSON object in this exact format:
    { "intent": "calendar", "date_keyword": "anidda" }
    { "intent": "chat", "date_keyword": null }
    { "intent": "add_info", "date_keyword": null }
    
    User text: "${text}"
    `;

    try {
        geminiRequestsToday++;
        const result = await generateContentWithRetry(model, prompt);
        const rawText = result.response.text().trim();
        const jsonMatch = rawText.match(/\{.*\}/s);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        console.error('Intent parsing error:', e);
    }
    return { intent: "chat", date_keyword: null };
}

// HTML Cleaner
function cleanHTML(text) {
    if (!text) return '';
    let cleanText = text;
    cleanText = cleanText.replace(/<[^>]*>/g, '');
    cleanText = cleanText.replace(/&amp;/g, '&');
    cleanText = cleanText.replace(/&lt;/g, '<');
    cleanText = cleanText.replace(/&gt;/g, '>');
    cleanText = cleanText.replace(/&quot;/g, '"');
    cleanText = cleanText.replace(/&#39;/g, "'");
    cleanText = cleanText.replace(/&nbsp;/g, ' ');
    cleanText = cleanText.replace(/\n\s*\n/g, '\n').trim();
    return cleanText;
}

// ================================================================
//  📅 CALENDAR READER (✅ අලුත් Timezone Fix + Singlish/Sinhala)
// ================================================================
const CALENDAR_API_KEY = process.env.CALENDAR_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID || 'ca0b38d172729231657abfc34f1c7fdb8ea33050fe6f4623f5fab88cd0d4633@group.calendar.google.com';

function getTargetDateRange(text) {
    const utcNow = new Date();
    let now = new Date(utcNow.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    let targetDate = new Date(now);
    const lowerText = text.toLowerCase().replace(/\s+/g, ''); 

    if (lowerText.includes('nextweek') || lowerText.includes('laban') || lowerText.includes('eelaga') || 
        lowerText.includes('eelagast') || lowerText.includes('balanna') || lowerText.includes('ඊළඟ') || lowerText.includes('ලබන')) {
        now = new Date(now);
        now.setDate(now.getDate() + 7);
        targetDate = new Date(now);
    }

    if (lowerText.includes('tomorrow') || lowerText.includes('tomorow') || /\bheta\b/.test(lowerText) || lowerText.includes('hetta') || lowerText.includes('හෙට')) {
        targetDate.setDate(now.getDate() + 1);
    } else if (lowerText.includes('today') || /\bada\b/.test(lowerText) || lowerText.includes('adda') || lowerText.includes('අද')) {
        // default to today
    } else if (lowerText.includes('anidda') || lowerText.includes('inannida') || lowerText.includes('අනිද්දා')) {
        targetDate.setDate(now.getDate() + 2);
    } else if (lowerText.includes('pereda') || lowerText.includes('පෙරේදා')) {
        targetDate.setDate(now.getDate() - 2);
    } else if (lowerText.includes('iyye') || lowerText.includes('ඊයේ')) {
        targetDate.setDate(now.getDate() - 1);
    } else {
        const days = [
            { names: ['sunday', 'ira', 'ඉරිදා'], value: 0 },
            { names: ['monday', 'sanduda', 'sandu', 'saduda', 'sadudaa', 'සඳුදා'], value: 1 },
            { names: ['tuesday', 'angaharuwada', 'අඟහරුවාදා'], value: 2 },
            { names: ['wednesday', 'badhada', 'බදාදා'], value: 3 },
            { names: ['thursday', 'bradaspatinda', 'sikurutha', 'brahaspathinda', 'බ්‍රහස්පතින්දා'], value: 4 },
            { names: ['friday', 'sikurda', 'sikuru', 'sikuradata', 'sikurudata', 'sikuruda', 'සිකුරාදා'], value: 5 },
            { names: ['saturday', 'sena', 'සෙනසුරාදා'], value: 6 }
        ];
        let isDayFound = false;
        for (let day of days) {
            for (let name of day.names) {
                if (lowerText.includes(name)) {
                    const diff = (day.value - now.getDay() + 7) % 7;
                    targetDate.setDate(now.getDate() + diff);
                    isDayFound = true;
                    break;
                }
            }
            if (isDayFound) break;
        }

        if (!isDayFound) {
            const months = [
                { names: ['january', 'janawari', 'ජනවාරි'], value: 0 },
                { names: ['february', 'pebarwari', 'පෙබරවාරි'], value: 1 },
                { names: ['march', 'marthu', 'මාර්තු'], value: 2 },
                { names: ['april', 'aprel', 'අප්‍රේල්'], value: 3 },
                { names: ['may', 'mayi', 'මැයි'], value: 4 },
                { names: ['june', 'juni', 'ජූනි'], value: 5 },
                { names: ['july', 'juli', 'ජූලි'], value: 6 },
                { names: ['august', 'agosthu', 'අගෝස්තු'], value: 7 },
                { names: ['september', 'septembar', 'සැප්තැම්බර්'], value: 8 },
                { names: ['october', 'oktobar', 'ඔක්තෝබර්'], value: 9 },
                { names: ['november', 'novembar', 'නොවැම්බර්'], value: 10 },
                { names: ['december', 'desembar', 'දෙසැම්බර්'], value: 11 }
            ];
            
            for (let month of months) {
                for (let name of month.names) {
                    if (lowerText.includes(name)) {
                        let match = lowerText.match(/(\d{1,2})(?:st|nd|rd|th)?/);
                        if (match) {
                            targetDate.setMonth(month.value);
                            targetDate.setDate(parseInt(match[1]));
                        } else {
                            targetDate.setMonth(month.value);
                        }
                        if (targetDate < now) {
                            targetDate.setFullYear(now.getFullYear() + 1);
                        }
                        break;
                    }
                }
            }
        }
    }

    const start = new Date(targetDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(targetDate);
    end.setHours(23, 59, 59, 999);
    return { start, end, targetDate };
}
async function getCalendarEvents(start, end) {
    if (!CALENDAR_API_KEY) {
        console.warn('⚠️ CALENDAR_API_KEY not set. Calendar will not work.');
        return null;
    }
    const calendar = google.calendar({ version: 'v3', auth: CALENDAR_API_KEY });
    try {
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            maxResults: 20,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return response.data.items;
    } catch (error) {
        console.error('Calendar API error:', error.message);
        return null;
    }
}

// ================================================================
//  ⏰ DAILY TIMETABLE AUTO-PUSH (✅ රෑ 9:30 ට හෙට දවස, Group + Students)
// ================================================================
async function sendDailyTimetable(sock) {
    if (studentRegistry.length === 0 && !GROUP_JID) {
        console.log('No students or group registered yet, skipping tomorrow push.');
        return;
    }

    // ✅ හෙට දවසේ Timetable එක ගන්නවා
    const { start, end, targetDate } = getTargetDateRange('tomorrow');

    // ✅ හෙට සති අන්තය නම් Message එක යවන්නේ නෑ.
    const dayOfWeek = targetDate.getDay(); 
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        console.log('හෙට සති අන්තයක් නිසා Timetable එක යවන්නේ නැහැ.');
        return;
    }

    const events = await getCalendarEvents(start, end);

    // ✅ හෙට Classes නැත්නම් Message එක යවන්නේ නෑ
    if (!events || events.length === 0) {
        console.log('හෙට Classes නැති නිසා Timetable Message එක යවන්නේ නැහැ.');
        return;
    }

    const formattedDate = targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' });

    let msgText = `🌙 *Good Evening!* හෙට (Tomorrow) දවසේ Classes:\n📅 *${formattedDate}*\n\n`;

    events.forEach((ev, idx) => {
        const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
        const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' });
        const location = ev.location || '';
        msgText += `${idx + 1}. *${ev.summary || 'Untitled'}*\n   🕒 ${startTime} - ${endTime}\n`;
        if (location) msgText += `   📍 ${location}\n\n`;
    });

    const wordKeys = Object.keys(academicWords);
    const randomWord = wordKeys[Math.floor(Math.random() * wordKeys.length)];
    msgText += `\n📚 *Word of the Day:* *${randomWord}* - ${academicWords[randomWord]}\n`;

    const tips = [
        "හෙට ලෙක්චර් එකට කලින් අදාළ නෝට්ස් බලන්න *\"pdf\"* කියලා type කරන්න. Files ලැබෙයි!",
        "හෙට Classes වලට යන්න කලින් ලෙක්චර් නෝට්ස් බලන්න අමතක කරන්න එපා!",
        "Bestie, හෙට ලෙක්චර් එකට කලින් *\"pdf\"* කියලා බලන්න, අදාළ notes ටික ready කරගන්න!"
    ];
    const randomTip = tips[Math.floor(Math.random() * tips.length)];
    msgText += `\n💡 *Tip:* ${randomTip}`;

    // ✅ Registered Students ලට යවනවා
    for (const jid of studentRegistry) {
        try {
            await sock.sendMessage(jid, { text: msgText });
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.error(`Failed to send to ${jid}:`, e.message);
        }
    }

    // ✅ Group එකටත් යවනවා
    if (GROUP_JID) {
        try {
            await sock.sendMessage(GROUP_JID, { text: msgText });
            console.log('✅ Group එකට හෙට දවසේ Timetable එක යවනවා!');
        } catch (e) {
            console.error(`Failed to send to group ${GROUP_JID}:`, e.message);
        }
    }
}

// ================================================================
//  📝 QUIZ GENERATOR (අද දවසේ PDF වලින්)
// ================================================================
async function handleQuizCommand(sock, sender, msg, specificModule = '') {
    try {
        const { start, end, targetDate } = getTargetDateRange('today');
        const events = await getCalendarEvents(start, end);

        if (!events || events.length === 0) {
            await sock.sendMessage(sender, { text: "🎉 අද Classes නෑ! Quiz එකක් හදන්න Modules නැහැ." }, { quoted: msg });
            return;
        }

        const todayModules = [];
        events.forEach(ev => {
            const summary = ev.summary || '';
            const moduleCodeMatch = summary.match(/(SE|IT|IE)\d{4}/i);
            if (moduleCodeMatch) {
                todayModules.push({
                    code: moduleCodeMatch[0].toUpperCase(),
                    fullName: summary,
                    event: ev
                });
            }
        });

        if (todayModules.length === 0) {
            await sock.sendMessage(sender, { text: "📭 අද Classes තියෙනවා, ඒත් Module Codes හඳුනාගන්න බැරි වුණා. Quiz එකක් හදන්න බැහැ." }, { quoted: msg });
            return;
        }

        if (!specificModule) {
            if (todayModules.length === 1) {
                specificModule = todayModules[0].code; 
            } else {
                const list = todayModules.map((m, i) => `${i+1}. *${m.code}* - ${m.fullName}`).join('\n');
                await sock.sendMessage(sender, { 
                    text: `📚 අද තියෙන Modules කිහිපයක් තියෙනවා. ඔයාට ඕන Module එක තෝරන්න:\n\n${list}\n\n👉 *Type කරන්න:* \`Quiz ${todayModules[0].code}\` (උදා: Quiz SE1020)` 
                }, { quoted: msg });
                return;
            }
        }

        const query = specificModule.toLowerCase();
        let targetModules = todayModules.filter(m => 
            m.code.toLowerCase().includes(query) || 
            m.fullName.toLowerCase().includes(query)
        );

        if (targetModules.length === 0) {
            const list = todayModules.map(m => m.code).join(', ');
            await sock.sendMessage(sender, { text: `⚠️ ඒ Module එක අද තියෙන්නේ නෑ! අද තියෙන Modules: *${list}*\n\nඋදාහරණයක් විදිහට: \`Quiz SE1020\`` }, { quoted: msg });
            return;
        }

        for (const module of targetModules) {
            const moduleCode = module.code;
            const moduleName = module.fullName || moduleCode;

            const moduleKeywords = MODULE_FILE_MAP[moduleCode] || [moduleCode.toLowerCase()];
            const file = fileRegistry.find(f => {
                const keyword = f.keyword.toLowerCase();
                return moduleKeywords.some(kw => keyword.includes(kw)) || 
                       moduleKeywords.some(kw => (f.fileName || '').toLowerCase().includes(kw));
            });

            if (!file) {
                let message;
                if (isSenderAdmin(sender)) {
                    message = `📭 ${moduleCode} සඳහා PDF File එකක් හම්බුනේ නැහැ.\n\n💡 *උපදෙස්:* අදාළ PDF එක \`add file: ${moduleCode} notes\` ලෙස Save කරන්න.`;
                } else {
                    message = `📭 ${moduleCode} සඳහා PDF File එකක් තාම Add කරලා නැහැ. Batch Rep ට දැනුම් දෙන්න.`;
                }
                await sock.sendMessage(sender, { text: message }, { quoted: msg });
                continue; 
            }

            const filePath = path.join(FILES_DIR, file.storedFileName);
            if (!fs.existsSync(filePath)) {
                await sock.sendMessage(sender, { text: `❌ ${moduleCode} සඳහා File එක Server එකේ නෑ. Admin ට කියන්න.` }, { quoted: msg });
                continue;
            }

            try {
                await sock.sendMessage(sender, { text: `📝 *${moduleCode}* සඳහා Quiz එක හදමින්...` }, { quoted: msg });

                const pdfBuffer = fs.readFileSync(filePath);
                const base64Pdf = pdfBuffer.toString('base64');
                const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };

                const quizPrompt = `You are a university lecturer. Based on the following lecture content for the module "${moduleName}", create a quiz with 10 questions.

RULES:
- Questions should test understanding, not just memorization.
- Include a mix of: Multiple Choice, True/False, and Short Answer.
- Provide clear correct answers.
- Format the quiz neatly for WhatsApp (use bullet points, bold text, emojis).
- **Language Rule (Important!):**
  1. The quiz questions and the main correct answers MUST be in **English**.
  2. After providing the correct answer in English, add a line starting with *"💡 Sinhala Explanation:"* and write a brief, clear explanation in **Sinhala** for that specific answer so the student can easily understand it.
  3. Use simple Sinhala words (Singlish / Sinhala script is fine) to explain concepts that might be difficult.

LECTURE CONTENT:
${/* PDF content will be sent as a part */ ''}

Generate the quiz now.`;

                geminiRequestsToday++;
                const result = await generateContentWithRetry(model, [quizPrompt, pdfPart]);
                const quizReply = formatMathForWhatsApp(result.response.text());

                const header = `📝 *${moduleCode} - Quiz* (${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })})\n───────────────────\n\n`;
                await sock.sendMessage(sender, { text: header + quizReply }, { quoted: msg });

            } catch (error) {
                console.error(`Error generating quiz for ${moduleCode}:`, error);
                await sock.sendMessage(sender, { text: `❌ ${moduleCode} Quiz එක හදන්න බැරි වුණා. නැවත try කරන්න.` }, { quoted: msg });
            }
        }

    } catch (error) {
        console.error('Quiz generation error:', error);
        await sock.sendMessage(sender, { text: "❌ Quiz එක හදන්න බැරි වුණා. නැවත try කරන්න." }, { quoted: msg });
    }
}

// ================================================================
//  🎵 AUDIO CONVERSION
// ================================================================
function convertAudioToMp3(inputBuffer) {
    return new Promise((resolve, reject) => {
        const uniqueId = crypto.randomUUID();
        const tempIn = path.join(__dirname, `temp_${uniqueId}.ogg`);
        const tempOut = path.join(__dirname, `temp_${uniqueId}.mp3`);
        fs.writeFileSync(tempIn, inputBuffer);
        ffmpeg(tempIn)
            .toFormat('mp3')
            .on('end', () => {
                try {
                    const outputBuffer = fs.readFileSync(tempOut);
                    if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                    if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                    resolve(outputBuffer);
                } catch (e) { 
                    if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                    if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                    reject(e); 
                }
            })
            .on('error', (err) => {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
                reject(err);
            })
            .save(tempOut);
    });
}

// ================================================================
//  💬 MAIN MESSAGE PROCESSING
// ================================================================
async function connectToWhatsApp() {
    try {
        console.log('🔄 Loading auth state...');
        const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info_baileys'));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            badSessionDeleteHistory: true,
            retryRequestDelayMs: 2000,
            fireInitQueries: false,
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                latestQR = qr;
                isConnected = false;
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (connection === 'close') {
                isConnected = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.error("❌ WhatsApp Connection Closed! Status Code:", statusCode);
                console.error("❌ Full Error:", lastDisconnect?.error);

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                sock.ev.removeAllListeners();
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 3s...');
                    setTimeout(() => connectToWhatsApp().catch(console.error), 3000);
                } else {
                    console.log('Logged out. Exiting.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                latestQR = "";
                isConnected = true;
                console.log('✅ WhatsApp AI Bot is Ready and Online!');
            }
        });

        // ⏰ CRON JOB (✅ හැමදාම රෑ 9:30 ට)
        cron.schedule('30 21 * * *', async () => {
            console.log('⏰ Running Tomorrow Timetable Push at 9:30 PM SL Time...');
            await sendDailyTimetable(sock);
        }, { timezone: 'Asia/Colombo' });

        // ----------------------------------------------------------------
        //  processMessage (✅ Duplicate Variables අයින් කරලා, Chat & File Fix Add කළා)
        // ----------------------------------------------------------------
        async function processMessage(sock, msg) {
            const sender = msg.key.remoteJid;

            // ✅ Variables ටික උඩින්ම define කරනවා (මේක අනිවාර්යයි!)
            const imgMsg = msg.message.imageMessage || msg.message.viewOnceMessage?.message?.imageMessage ||
                           msg.message.viewOnceMessageV2?.message?.imageMessage || msg.message.ephemeralMessage?.message?.imageMessage;
            const audioMsg = msg.message.audioMessage || msg.message.viewOnceMessage?.message?.audioMessage ||
                             msg.message.ephemeralMessage?.message?.audioMessage;
            const docMsg = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage ||
                           msg.message.ephemeralMessage?.message?.documentMessage;
            const firstMsgType = Object.keys(msg.message)[0];
            const contextInfo = msg.message[firstMsgType]?.contextInfo || msg.message.extendedTextMessage?.contextInfo;
            const quotedMsgObj = contextInfo?.quotedMessage;
            const quotedText = quotedMsgObj?.conversation || quotedMsgObj?.extendedTextMessage?.text ||
                               quotedMsgObj?.imageMessage?.caption || "";
            const rawMessageText = msg.message.conversation || msg.message.extendedTextMessage?.text ||
                                   imgMsg?.caption || docMsg?.caption || "";

            let fullUserPrompt = rawMessageText;
            if (quotedText) fullUserPrompt = `[Quoted: "${quotedText}"]\nUser: "${rawMessageText}"`;

            // ✅ Group එකකින් ආවොත් ignore කරනවා
            const isGroup = sender.endsWith('@g.us');
            if (isGroup) {
                if (isSenderAdmin(sender) && rawMessageText.toLowerCase().trim() === 'getid') {
                    await sock.sendMessage(sender, { text: `🆔 *Group ID:* \`${sender}\`` }, { quoted: msg });
                    return;
                }

                if (!GROUP_JID) {
                    console.log(`📢 Group ID Found (Silent Log): ${sender}`);
                }
                return; 
            }

            // ✅ Group එකක් නෙවෙයි නම් විතරයි Student register වෙන්නේ
            const isNewUser = addStudent(sender);
            if (isNewUser) {
                await sock.sendMessage(sender, { text: "Hello! I am *HansanaBot*, your AI assistant! 👋\n\nType *help* to see what I can do for you. 🚀" }, { quoted: msg });
            }

            const rateCheck = checkRateLimit(sender);
            if (!rateCheck.allowed) {
                await sock.sendMessage(sender, { text: rateCheck.reason }, { quoted: msg });
                return;
            }   

            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate('composing', sender);

            // ---------- AUDIO ----------
            if (audioMsg) {
                try {
                    await sock.sendMessage(sender, { text: "🎙️ **Voice Note Process වෙමින්...**" }, { quoted: msg });
                    const oggBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    const mp3Buffer = await convertAudioToMp3(oggBuffer);
                    const base64Audio = mp3Buffer.toString('base64');
                    const audioPart = { inlineData: { data: base64Audio, mimeType: 'audio/mp3' } };
                    const prompt = buildPromptWithKnowledge("Listen to this audio and reply.");
                    const result = await generateContentWithRetry(model, [prompt, audioPart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (err) {
                    console.error('Audio error:', err);
                    await sock.sendMessage(sender, { text: "❌ Voice message එක process කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- ADD FILE (Admin) ----------
            if (docMsg && /^add file\b/i.test(rawMessageText.toLowerCase().trim())) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ මේක කරන්න පුළුවන් Batch Rep ට විතරයි!" }, { quoted: msg });
                    return;
                }
                const keyword = rawMessageText.replace(/^add file\s*:?\s*/i, '').trim().toLowerCase();
                if (!keyword) {
                    await sock.sendMessage(sender, { text: "⚠️ Keyword එකත් caption එකේ දෙන්න: add file: course outline" }, { quoted: msg });
                    return;
                }
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const ext = path.extname(docMsg.fileName || '') || '.pdf';
                    const storedFileName = `${crypto.randomUUID()}${ext}`;
                    fs.writeFileSync(path.join(FILES_DIR, storedFileName), buffer);
                    fileRegistry.push({
                        keyword, fileName: docMsg.fileName || `${keyword}${ext}`,
                        mimetype: docMsg.mimetype || 'application/pdf',
                        storedFileName
                    });
                    saveFileRegistry();
                    await sock.sendMessage(sender, { text: `✅ File save කළා! Keyword: "${keyword}"` }, { quoted: msg });
                } catch (err) {
                    console.error('Save file error:', err);
                    await sock.sendMessage(sender, { text: "❌ File save කිරීම අසාර්ථකයි." }, { quoted: msg });
                }
                return;
            }

            // ---------- PDF ANALYSIS ----------
            if (docMsg) {
                try {
                    if (docMsg.mimetype === 'application/pdf') {
                        await sock.sendMessage(sender, { text: "📄 **PDF Read කරමින්...**" }, { quoted: msg });
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Pdf = buffer.toString('base64');
                        const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };
                        const prompt = buildPromptWithKnowledge(`Read PDF and respond. User: ${rawMessageText || ''}`);
                        const result = await generateContentWithRetry(model, [prompt, pdfPart]);
                        const reply = formatMathForWhatsApp(result.response.text());
                        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('PDF error:', err);
                    await sock.sendMessage(sender, { text: "❌ File එක විවෘත කරන්න බැරි වුණා. ආයේ උත්සාහ කරන්න." }, { quoted: msg });
                }
                return;
            }

            // ---------- IMAGE ----------
            if (imgMsg) {
                try {
                    await sock.sendMessage(sender, { text: "⏳ **Image Process වෙමින්...**" }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const mimeType = imgMsg.mimetype || 'image/jpeg';
                    const imagePart = { inlineData: { data: base64Image, mimeType: mimeType } };
                    const prompt = buildPromptWithKnowledge(`Analyze image. User: ${rawMessageText || ''}`);
                    const result = await generateContentWithRetry(model, [prompt, imagePart]);
                    const reply = formatMathForWhatsApp(result.response.text());
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (err) {
                    console.error('Image error:', err);
                    await sock.sendMessage(sender, { text: "❌ Image process කරන්න බැරි වුණා." }, { quoted: msg });
                }
                return;
            }

            // ---------- TEXT COMMANDS ----------
            const textLower = rawMessageText.toLowerCase().trim();

            // ---------- QUIZ COMMAND ----------
            const quizMatch = textLower.match(/^quiz\s+(.+)$/); // "quiz oop", "quiz se1020" වගේ
            if (textLower === 'quiz' || textLower === 'quiz එකක්' || textLower === 'quiz ekk' || quizMatch) {
                const moduleQuery = quizMatch ? quizMatch[1].trim() : ''; // තෝරපු module එක
                await handleQuizCommand(sock, sender, msg, moduleQuery);
                return;
            }

            // STATUS (Admin)
            if (textLower === 'status') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const statusMsg = `✅ *HansanaBot Status*\n\n👥 *Used Requests:* ${geminiRequestsToday}/500\n📁 *Total Files:* ${fileRegistry.length}\n📚 *Saved Info:* ${knowledgeBase.length}\n👥 *Registered Students:* ${studentRegistry.length}`;
                await sock.sendMessage(sender, { text: statusMsg }, { quoted: msg });
                return;
            }

            // ADD INFO (Admin)
            if (/^(add info|info add|save info)\b/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                if (!infoText) {
                    await sock.sendMessage(sender, { text: "⚠️ Please provide info text." }, { quoted: msg });
                    return;
                }
                knowledgeBase.push(infoText);
                saveKnowledgeBase();
                await sock.sendMessage(sender, { text: `✅ Info saved! (Total: ${knowledgeBase.length})` }, { quoted: msg });
                return;
            }

                        // 🚨 SMART FILE HANDLING
            const explicitFileWords = /\b(pdf|file|send|download|document|danna|ewanna|yawanna|evidence|source|uththara|sadaha|reference|prove|copy|read|explain|define|what)\b/i;
            const isExplicitFileRequest = explicitFileWords.test(textLower);

            // ✅ අලුත්ම FIX: සාමාන්‍ය Chat ප්‍රශ්න නම් File Block එකට යන්න දෙන්නේ නෑ!
            const generalChatRegex = /adaraya|adara|kohomada|kohomda|what is love|meka mokadda|mokadda|mokakda|ayubowan|suba|thanks|stuti|mata|mage|kelle|kella|set|kohome|wage|kenek|kohomada|mokakda|meka|kohomada|kohomda|ආදරය|කෙල්ල|කොහොමද|මොකක්ද/i;
            const isGeneralChat = generalChatRegex.test(textLower);

            // ඒ නිසා General Chat නම්, File එක සෙවීම සම්පූර්ණයෙන්ම Skip කරනවා
            if (!isGeneralChat) {
                let matchedFile = fileRegistry.find(f => {
                    const kw = f.keyword.toLowerCase();
                    const kwWords = kw.split(/[\s,:.!?()]+/).filter(w => w.length >= 2);
                    return textLower.includes(kw) || kwWords.some(word => textLower.includes(word));
                });

                if (matchedFile) {
                    const filePath = path.join(FILES_DIR, matchedFile.storedFileName);

                    if (isExplicitFileRequest || matchedFile.mimetype !== 'application/pdf') {
                        try {
                            if (fs.existsSync(filePath)) {
                                const buffer = fs.readFileSync(filePath);
                                await sock.sendMessage(sender, {
                                    document: buffer,
                                    mimetype: matchedFile.mimetype || 'application/pdf',
                                    fileName: matchedFile.fileName || 'document.pdf'
                                }, { quoted: msg });
                            } else {
                                await sock.sendMessage(sender, { text: "❌ File එක නෑ. Bot එක Restart වෙලා නම් Admin ට කියලා ආයේ Add කරන්න." }, { quoted: msg });
                            }
                        } catch (err) {
                            console.error('❌ Error sending file:', err);
                            await sock.sendMessage(sender, { text: "❌ File එක යවන්න අවුලක් වුණා. නැවත try කරන්න." }, { quoted: msg });
                        }
                        return;
                    }

                    try {
                        if (fs.existsSync(filePath)) {
                            const pdfBuffer = fs.readFileSync(filePath);
                            const base64Pdf = pdfBuffer.toString('base64');
                            const pdfPart = { inlineData: { data: base64Pdf, mimeType: 'application/pdf' } };

                            const queryPrompt = `Read the attached PDF file. The user has asked: "${rawMessageText}".\n\nAnswer the user's question directly, briefly, and clearly based *ONLY* on the information in the PDF file. If the answer is not in the PDF, say "Sorry, this information is not in the file." Do not mention the file name unless necessary.`;

                            geminiRequestsToday++;
                            const result = await generateContentWithRetry(model, [queryPrompt, pdfPart]);
                            const reply = formatMathForWhatsApp(result.response.text());

                            lastFileContext[sender] = matchedFile;

                            const userGuide = `\n\n📄 *ඔයාට මේ තොරතුරු වල සාක්ෂි (Evidence) බලන්න ඕනද?*\n👉 එතකොට *"pdf"* කියලා type කරන්න.`;

                            await sock.sendMessage(sender, { text: reply + userGuide }, { quoted: msg });
                        } else {
                            await sock.sendMessage(sender, { text: "❌ File එක නෑ. Admin ට කියලා ආයේ Add කරන්න." }, { quoted: msg });
                        }
                    } catch (error) {
                        console.error('AI File Query Error:', error);
                        await sock.sendMessage(sender, { text: "❌ File එක විවෘත කරන්න බැරි වුණා. ආයේ උත්සාහ කරන්න." }, { quoted: msg });
                    }
                    return;
                }
            }

            // 🚨 REMOVE INFO (Admin)
            if (/^remove info\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const idx = parseInt(textLower.replace(/^remove info\s+/i, ''), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= knowledgeBase.length) {
                    await sock.sendMessage(sender, { text: "⚠️ Invalid number. Use 'list info'." }, { quoted: msg });
                    return;
                }
                const removed = knowledgeBase.splice(idx, 1);
                saveKnowledgeBase();
                await sock.sendMessage(sender, { text: `🗑️ Removed: "${removed[0]}"` }, { quoted: msg });
                return;
            }

            // AI INTENT
            const aiIntent = await getCalendarIntentFromAI(rawMessageText);

            // 🚨 අලුත් Fix: Chat වචන Blacklist (මේවා ආවොත් කවදාවත් Timetable එකට යන්නේ නෑ!)
            const chatWords = /adaraya|adara|kohomada|kohomda|what is love|meka mokadda|mokadda|mokakda|ayubowan|suba|thanks|stuti/i;
            if (chatWords.test(textLower)) {
                aiIntent.intent = 'chat';
                aiIntent.date_keyword = null;
            } else {
                if (/exam|quiz|mid|test|assessment|date|kawadda|set wenne|විභාග|ප්‍රශ්න|කුසීස්|මචි/i.test(textLower)) {
                    aiIntent.intent = 'chat';
                    aiIntent.date_keyword = null;
                }
                // ✅ \b ටික add කරලා "ada" එක "adaraya" එකේ match වෙන එක නැවැත්තුවා
                const isDayMonthQuery = /\b(sanduda|saduda|sikurda|sikurada|eelaga|laban|balanna|ada|heta|anidda|monday|tuesday|wednesday|thursday|friday|saturday|sunday|janawari|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(textLower);
                if (isDayMonthQuery) {
                   aiIntent.intent = 'calendar';
                   if (!aiIntent.date_keyword) {
                       aiIntent.date_keyword = textLower;
                    }
                } 
            }

            if (aiIntent.intent === 'calendar') {
                const { start, end, targetDate } = getTargetDateRange(aiIntent.date_keyword || textLower);
                const events = await getCalendarEvents(start, end);

                if (events && events.length > 0) {
                    let msgText = `📅 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })} දින Classes:*\n\n`;
                    events.forEach((ev, idx) => {
                        const startTime = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const endTime = new Date(ev.end?.dateTime || ev.end?.date).toLocaleString('en-LK', { timeZone: 'Asia/Colombo', hour: '2-digit', minute:'2-digit' });
                        const location = ev.location || '';
                        const description = ev.description || '';
                        
                        msgText += `${idx+1}. *${ev.summary || 'Untitled'}*\n`;
                        msgText += `   🕒 ${startTime} – ${endTime}\n`;
                        if (location) msgText += `   📍 *ස්ථානය (Location):* ${location}\n`;
                        if (description) msgText += `   📝 *විස්තරය (Details):* ${cleanHTML(description)}\n`;
                        msgText += `\n`;
                    });
                    msgText += `\n🔗 *Full Calendar:* https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}`;
                    await sock.sendMessage(sender, { text: msgText }, { quoted: msg });
                } else {
                    // ✅ දවස සංසන්දනය කරලා බලනවා (අදට වඩා ඉදිරියෙන්ද කියලා)
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const futureDate = new Date(targetDate);
                    futureDate.setHours(0, 0, 0, 0);
                    const diffDays = Math.ceil((futureDate - today) / (1000 * 60 * 60 * 24));

                    // ඉල්ලපු දවස අදට වඩා දින 3ක් හෝ ඊට වැඩියෙන් ඉදිරියෙන් නම් (Next Week වගේ)
                    if (diffDays >= 3) {
                        await sock.sendMessage(sender, { text: `⚠️ *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}* දිනට අදාළ Timetable එක තාම Google Calendar එකට එකතු කරලා නැහැ. ටික වේලාවකින් ආයේ අහන්න, නැත්නම් Batch Rep ට දැනුම් දෙන්න!` }, { quoted: msg });
                    } else {
                        // අද, හෙට, අනිද්දා වගේ දවස් වලට පමණයි "Classes නෑ" කියන්නේ
                        await sock.sendMessage(sender, { text: `🎉 *${targetDate.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' })}* දිනට Classes නෑ!` }, { quoted: msg });
                    }
                }
                return;
            }
            
            if (aiIntent.intent === 'add_info' && isSenderAdmin(sender)) {
                const infoText = rawMessageText.replace(/^(add info|info add|save info)\s*:?\s*/i, '').trim();
                if (infoText) {
                    knowledgeBase.push(infoText);
                    saveKnowledgeBase();
                    await sock.sendMessage(sender, { text: `✅ Info saved! (Total: ${knowledgeBase.length})` }, { quoted: msg });
                    return;
                }
            }

            // WHO AM I
            if (/\bwho\s*am\s*i\b/i.test(textLower) || textLower.includes('man kauda') || textLower.includes('mama kauda')) {
                const isAdmin = isSenderAdmin(sender);
                if (isAdmin) {
                    await sock.sendMessage(sender, { text: `👋 ඔයා *Monal Hansana* — Batch Rep! ✅` }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `👤 ඔයා student කෙනෙක්.` }, { quoted: msg });
                }
                return;
            }

            // GEN Z GUIDE
            if (textLower === 'guide' || textLower === 'genz' || textLower === 'how to use') {
                const genZGuide = `Yo bestie! 👋🔥 I'm *HansanaBot*, your AI slay assistant! No cap, I got your back! 🫡✨

🛠️ *How to use me (fr fr):*
👉 Just type *"ada class"* or *"heta class"* to see what's poppin' today/tomorrow.
👉 Need notes? Type *"pdf"* to get the actual file!
👉 Type *"word"* to learn a new academic word daily! (Smart move, bestie! 🧠✨)
👉 Got a random question? Just ask me in Sinhala or English.
👉 *"status"* is only for the main character (Admin) 💅

Catch my drift? Slide into my DMs and let's get that GPA up! 📈🚀`;
                await sock.sendMessage(sender, { text: genZGuide }, { quoted: msg });
                return;
            }

            // HELP MENU
            if (textLower === 'help' || textLower === '/help' || textLower === 'menu' || textLower === '/menu' || textLower === 'start' || textLower === '/start' || textLower === 'commands' || textLower === 'hi' || textLower === 'hello' || textLower === 'hey' || textLower === 'hii' || textLower === 'hlo' || textLower === 'hi there' || textLower === 'good morning' || textLower === 'good night' || textLower === 'suba') {
                const isAdmin = isSenderAdmin(sender);
                let helpText = `👋 *HansanaBot Help Menu* 🤖

*General Commands:*
📌 *guide* - Gen Z Style Guide එක බලන්න
🆔 *whoami* - ඔයාගේ ID එක බලන්න
👤 *who am i* - Adminද Studentද කියලා බලන්න
📖 *word* - Academic Word Practice (නව වචන ඉගෙන ගන්න)
📅 *calendar* - අද / හෙට / ඉදිරි දවස් වල Classes බලන්න
📂 *pdf* - Save කරලා තියෙන Files ලබා ගන්න
📝 *quiz* - අද දවසේ Modules වලින් Quiz එකක්

*📞 Support:*
Contact Batch Rep: +94 76 251 3957`;

                if (isAdmin) {
                    helpText += `

*🛠️ Admin Commands (Only for Batch Rep):*
📝 *add info: [text]* - අලුත් තොරතුරු save කරන්න
📚 *list info* - Save කරලා තියෙන Info ටික බලන්න
🗑️ *remove info [number]* - Info එකක් අයින් කරන්න
📤 *add file: [keyword]* - PDF/Image එකක් save කරන්න
📋 *list files* - Save කරලා තියෙන Files ටික බලන්න (PDF එකත් එනවා!)
🗑️ *remove file [number]* - File එකක් අයින් කරන්න
📊 *status* - Bot එකේ තත්වය බලන්න`;
                }
                
                await sock.sendMessage(sender, { text: helpText }, { quoted: msg });
                return;
            }

            // WHOAMI
            if (textLower === 'whoami' || textLower === 'myid') {
                const normalized = jidNormalizedUser(sender) || sender;
                await sock.sendMessage(sender, { text: `🆔 Your ID: \`${normalized}\`` }, { quoted: msg });
                return;
            }

            // CALENDAR HELP
            if (textLower === 'calendar help' || textLower === 'calendar not showing' || textLower === 'sync calendar') {
                await sock.sendMessage(sender, {
                    text: `📅 *Calendar Troubleshooting*\n\n🔗 Link: https://calendar.google.com/calendar/u/0?cid=${encodeURIComponent(CALENDAR_ID)}\n\n*Steps:*\n1. Google Calendar App → ☰ Menu → "Other calendars" → Check "SLIIT Timetable".\n2. Settings → Accounts → Google → SLIIT email → Calendars ON.\n3. Settings → Accounts → Sync Calendar ON.\n4. Unsubscribe and re-add.\n\n📱 Still not working? Contact Batch Rep: +94 76 251 3957`
                }, { quoted: msg });
                return;
            }

            // LIST FILES (Admin)
            if (textLower === 'list files' || textLower === 'show files') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (fileRegistry.length === 0) {
                    await sock.sendMessage(sender, { text: "📭 No files saved." }, { quoted: msg });
                } else {
                    const list = fileRegistry.map((f, i) => `${i+1}. "${f.keyword}" → ${f.fileName}`).join('\n');
                    await sock.sendMessage(sender, { text: `📁 *Saved Files (${fileRegistry.length})*\n\n${list}` }, { quoted: msg });

                    for (const f of fileRegistry) {
                        const filePath = path.join(FILES_DIR, f.storedFileName);
                        if (fs.existsSync(filePath)) {
                            const buffer = fs.readFileSync(filePath);
                            await sock.sendMessage(sender, {
                                document: buffer,
                                mimetype: f.mimetype || 'application/pdf',
                                fileName: f.fileName || 'document.pdf'
                            }, { quoted: msg });
                            await new Promise(r => setTimeout(r, 1500));
                        } else {
                            console.error(`File not found: ${filePath}`);
                        }
                    }
                }
                return;
            }

            // REMOVE FILE (Admin)
            if (/^remove file\s+\d+/i.test(textLower)) {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                const idx = parseInt(textLower.replace(/^remove file\s+/i, ''), 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= fileRegistry.length) {
                    await sock.sendMessage(sender, { text: "⚠️ Invalid number. Use 'list files' to see." }, { quoted: msg });
                    return;
                }
                const [removed] = fileRegistry.splice(idx, 1);
                saveFileRegistry();
                try {
                    const filePath = path.join(FILES_DIR, removed.storedFileName);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (e) { console.error('Delete file error:', e); }
                await sock.sendMessage(sender, { text: `🗑️ Removed: "${removed.keyword}"` }, { quoted: msg });
                return;
            }

            // LIST INFO (Admin)
            if (textLower === 'list info' || textLower === 'show info') {
                if (!isSenderAdmin(sender)) {
                    await sock.sendMessage(sender, { text: "❌ Batch Rep only!" }, { quoted: msg });
                    return;
                }
                if (knowledgeBase.length === 0) await sock.sendMessage(sender, { text: "📭 No info saved." }, { quoted: msg });
                else {
                    const list = knowledgeBase.map((k, i) => `${i+1}. ${k}`).join('\n\n');
                    await sock.sendMessage(sender, { text: `📚 *Saved Info (${knowledgeBase.length})*\n\n${list}` }, { quoted: msg });
                }
                return;
            }

           
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

            // 🙏 THANKS AUTO-REPLY
            if (textLower.includes('thanks') || textLower.includes('thank you') || textLower.includes('sthuthi') || textLower.includes('stuti') || textLower.includes('bohoma sthuthi')) {
                await sock.sendMessage(sender, { text: "ඔයාව සාදරයෙන් පිළිගන්නවා! 🥰❤️ තව මොනවා හරි ඕන නම් අහන්න!" }, { quoted: msg });
                return;
            }

            // ---------- GENERAL AI RESPONSE (මතකය සමඟ) ----------
            if (rawMessageText) {
                try {
                    const history = getRecentContext(sender);
                    let promptToSend = fullUserPrompt;
                    if (history) {
                        promptToSend = `පෙර සංවාදය:\n${history}\n\nවත්මන් ප්‍රශ්නය: ${fullUserPrompt}`;
                    }
                    geminiRequestsToday++;
                    const result = await generateContentWithRetry(model, buildPromptWithKnowledge(promptToSend));
                    const reply = formatMathForWhatsApp(result.response.text());
                    addToMemory(sender, 'User', fullUserPrompt);
                    addToMemory(sender, 'Bot', reply);
                    await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                } catch (error) {
                    console.error('Gemini error:', error);
                    await sock.sendMessage(sender, { text: "❌ සමාවෙන්න, මට දැන් උත්තර දෙන්න බැරි වුණා. නැවත try කරන්න." }, { quoted: msg });
                }
            }
        }

        // ----------------------------------------------------------------
        //  messages.upsert
        // ----------------------------------------------------------------
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                if (processedMessages.has(msg.key.id)) continue;
                markProcessed(msg.key.id);
                messageQueue.add(
                    () => processMessage(sock, msg),
                    async (position) => {
                        try {
                            await sock.sendMessage(msg.key.remoteJid, { text: `⏳ ඉන්න! Queue: ${position}. ඉක්මනට reply කරන්නම්! 🙏` }, { quoted: msg });
                        } catch (e) { /* ignore */ }
                    }
                ).catch(err => console.error('Queue error:', err));
            }
        });

    } catch (error) {
        console.error('Connection error:', error);
        setTimeout(() => connectToWhatsApp(), 5000);
    }
}

// ================================================================
//  🚀 START
// ================================================================
connectToWhatsApp();
