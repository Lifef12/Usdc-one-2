const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

// ethers sirf auto-payout ke liye chahiye. Install: npm i ethers
let ethers = null;
try { ethers = require('ethers'); } catch (e) { console.log('ℹ️ ethers not installed - auto payout disabled (run: npm i ethers)'); }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '6959332288');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN || !MONGO_URI || !ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_ID) {
    console.error('❌ Missing env: BOT_TOKEN, MONGO_URI, ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_ID required.');
    process.exit(1);
}

const WEBHOOK_SECRET = crypto.createHash('sha256').update('wh' + BOT_TOKEN).digest('hex').slice(0, 32);

// ---------- MONEY (BabyDoge) ----------
// Balance database me INTEGER micro-units me rakha jata hai (1 BabyDoge = 1,000,000) taake float ki galti na ho.
const COIN = 'BabyDoge';
const U = 1e6;
const toMicro = x => Math.round(Number(x) * U);
const fromMicro = m => Math.round(Number(m) || 0) / U;
const fmtU = m => String(Number((Number(m) / U).toFixed(6)));          // plain number (on-chain ke liye)
const fmtD = m => (Number(m) / U).toLocaleString('en-US', { maximumFractionDigits: 2 });   // display (commas)

const TASK_REWARD = 2e6 * U;          // 2M BabyDoge per task (3 tasks)
const REF_BONUS = 5e6 * U;           // 5M BabyDoge per referral
const JOIN_BONUS = 1e6 * U;          // 1M BabyDoge joining bonus (pehli baar verify par)
const DAILY_BONUS = 0.5e6 * U;       // 500K BabyDoge daily bonus (din me ek baar, UTC)
const MIN_WITHDRAW = 50e6 * U;      // 50M BabyDoge minimum withdraw
const MIN_REFS = 4;                  // withdraw ke liye kam az kam itne VERIFIED referrals zaroori

// ---------- AUTO PAYOUT (Baby Doge BEP-20 / BSC) ----------
// Render env me set karo:
//   PAYOUT_PRIVATE_KEY = payout wallet ki private key (sirf env me, kabhi code me nahi). Is wallet me BabyDoge + thora BNB (gas) rakho.
//   BSC_RPC            = (optional) default https://bsc-dataseed.binance.org/
//   AUTO_PAYOUT        = 'false' likho to auto band (admin approve karega). Default: key ho to ON.
//   MAX_AUTO_PAYOUT    = (optional) is amount (BabyDoge) se bade withdraw admin approval par jayenge. Default 100,000,000.
// Key na ho to manual approve system chalta hai.
const PAYOUT_PRIVATE_KEY = (process.env.PAYOUT_PRIVATE_KEY || '').trim();
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/';
const TOKEN_BSC = '0xc748673057861a797275CD8A068AbB95A902e8de';   // Baby Doge Coin (BEP-20), 9 decimals
const TOKEN_DECIMALS = 9;
const AUTO_PAYOUT = process.env.AUTO_PAYOUT !== 'false';
const MAX_AUTO_PAYOUT = toMicro(process.env.MAX_AUTO_PAYOUT || 100000000);
const MIN_GAS_BNB = '0.0005';

let payoutWallet = null, tokenContract = null, payoutProvider = null;
if (ethers && PAYOUT_PRIVATE_KEY) {
    try {
        payoutProvider = new ethers.JsonRpcProvider(BSC_RPC, 56, { staticNetwork: ethers.Network.from(56) });
        payoutWallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, payoutProvider);
        tokenContract = new ethers.Contract(TOKEN_BSC, [
            'function transfer(address to, uint256 amount) returns (bool)',
            'function balanceOf(address) view returns (uint256)'
        ], payoutWallet);
        console.log('✅ Payout wallet ready:', payoutWallet.address);
    } catch (e) {
        console.error('❌ Invalid PAYOUT_PRIVATE_KEY:', e.message);
        payoutWallet = null; tokenContract = null;
    }
}
const payoutReady = () => !!(payoutWallet && tokenContract);

// BabyDoge on-chain bhejo. Success par { hash }, fail par error throw (paise nahi gaye).
async function sendToken(address, microAmount) {
    if (!payoutReady()) throw new Error('Payout wallet not configured');
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('Invalid address');
    const units = ethers.parseUnits(fmtU(microAmount), TOKEN_DECIMALS);

    const bal = await tokenContract.balanceOf(payoutWallet.address);
    if (bal < units) throw new Error('Payout wallet has not enough ' + COIN);
    const gas = await payoutProvider.getBalance(payoutWallet.address);
    if (gas < ethers.parseEther(MIN_GAS_BNB)) throw new Error('Payout wallet needs BNB for gas');

    const tx = await tokenContract.transfer(address, units);
    try {
        const rc = await tx.wait(1, 90000);
        if (rc && rc.status === 0) throw new Error('REVERTED');
    } catch (e) {
        if (String(e.message) === 'REVERTED') throw new Error('Transaction reverted on-chain');
        // timeout: tx bhej di gayi hai, confirm hone me der. Paid maan lo.
    }
    return { hash: tx.hash };
}

// ---------- TAP SYSTEM ----------
// Ek line = TAP_TARGET taps. Line poori hone par seedha nayi line (koi wait nahi). Din me ROUNDS_PER_DAY lines.
// 10 lines x 1M = 10M BabyDoge / din.  (Frontend ke constants se match hona zaroori hai)
const TAP_TARGET = 30;
const ROUNDS_PER_DAY = 10;
const ROUND_REWARD = 1e6 * U;        // 1M BabyDoge per line (10 lines = 10M / din)
const COOLDOWN = 0;                  // line ke baad koi wait nahi (timer band)
const MAX_TPS = 14;                  // insani limit: taps / second (server isse zyada credit nahi karta)
const BOT_USERNAME = 'BabydogeTapfiTg_Bot';

// YouTube: Submit ke kitni der baad Claim allowed hoga. 0 = delay nahi.
const YT_CLAIM_DELAY = 10 * 1000;

// ---------- CHANNELS ----------
const CHANNEL_UPDATES = { id: '@updatechanneluta', name: 'Official Updates Channel', url: 'https://t.me/updatechanneluta' };
const CHANNEL_PAYOUTS = { id: '@cryptotech16', name: 'Official Payouts Channel', url: 'https://t.me/cryptotech16' };

// Verification ke liye channels (app khulne par dono join hone zaroori)
const VERIFY_CHANNELS = [CHANNEL_UPDATES, CHANNEL_PAYOUTS];

// Telegram task (auto verify)
// Bot ko @paymentchanneluta me admin banana zaroori hai (membership check ke liye).
const TASK_CHANNEL = { id: '@paymentchanneluta', name: 'Telegram Task Channel' };

// Payment proof channel: har paid withdraw yahan auto post hota hai.
const PAYMENT_CHANNEL = '@cryptotech16';

// YouTube tasks (Open -> Submit -> Claim)
const YT_TASKS = ['yt1', 'yt2'];

// Welcome message ke saath dikhne wali image/GIF (DIRECT link hona zaroori hai: i.ibb.co/...)
// Env me WELCOME_IMG set karke badal sakte ho. Khali ('') likho to sirf text jayega.
const WELCOME_IMG = process.env.WELCOME_IMG !== undefined
    ? process.env.WELCOME_IMG
    : 'https://i.ibb.co/KpB6QLQF/baby-doge-mining-animation.gif';

const WELCOME_TEXT = 'Hello, welcome to <b>BabyDoge TapFi</b>! 🐶 Get ready for an exciting earning experience!\n\n' +
    'Join us, tap the coin, complete daily challenges, and invite your friends to earn BabyDoge rewards! ' +
    'Build your team and boost your daily earnings!\n\n' +
    '🔥 <b>Let\'s earn with BabyDoge TapFi!</b>';

// ---------- DATABASE (server band nahi hota, DB connect na ho to retry karta hai) ----------
async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
        console.log('✅ MongoDB connected');
    } catch (err) {
        console.error('❌ MongoDB error:', err.message, '- retrying in 10s');
        setTimeout(connectDB, 10000);
    }
}
connectDB();

const dbReady = () => mongoose.connection.readyState === 1;

const UserSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },            // micro-units (integer)
    isVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    deviceOk: { type: Boolean, default: false },      // admin ne allow kiya: fingerprint/IP matching se block nahi hoga
    tasks: {
        tg2: { type: Boolean, default: false },
        yt1: { type: Boolean, default: false },
        yt2: { type: Boolean, default: false }
    },
    // tap system (UTC din ke hisaab se reset)
    tapDay: { type: String, default: '' },
    tapDone: { type: Number, default: 0 },
    tapLine: { type: Number, default: 0 },
    tapNext: { type: Number, default: 0 },
    lastTapAt: { type: Number, default: 0 },
    // daily bonus (UTC din)
    dailyDay: { type: String, default: '' },
    // withdraw wallet: pehle withdraw par lock, ek wallet = ek account
    wallet: { type: String, default: null },
    referredBy: { type: String, default: null },
    refCredited: { type: Boolean, default: false },
    joinBonus: { type: Boolean, default: false },
    refMilestone: { type: Boolean, default: false },
    referrals: { type: Array, default: [] },
    totalWithdrawn: { type: Number, default: 0 },     // micro-units
    withdrawals: { type: Array, default: [] },
    createdAt: { type: Number, default: Date.now }
});
// Ek wallet sirf ek account par (null wale ignore hote hain)
UserSchema.index({ wallet: 1 }, { unique: true, partialFilterExpression: { wallet: { $type: 'string' } } });
// Team list / purane referrals dhoondne ke liye
UserSchema.index({ referredBy: 1 });
const User = mongoose.model('User', UserSchema);

// ONE-TIME FIX: purane users jinki referrals / withdrawals field array nahi hai ("Cannot apply $pull to a non-array value" error)
// Ye har start par chalta hai, safe hai (sirf kharab documents ko [] banata hai).
mongoose.connection.on('open', async () => {
    try {
        const a = await User.collection.updateMany({ referrals: { $not: { $type: 'array' } } }, { $set: { referrals: [] } });
        const b = await User.collection.updateMany({ withdrawals: { $not: { $type: 'array' } } }, { $set: { withdrawals: [] } });
        console.log('🛠 Array fields fixed -> referrals:', a.modifiedCount, '| withdrawals:', b.modifiedCount);
    } catch (e) { console.log('Array fix error:', e.message); }
});

// userId unique: ek user ki ek waqt mein sirf ek pending withdrawal
const PendingRequest = mongoose.model('PendingRequest', new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },         // micro-units
    address: { type: String, required: true }
}));

// YouTube pending claim: userId unique => ek user ka ek waqt mein sirf ek pending claim.
const PendingClaim = mongoose.model('PendingClaim', new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    task: { type: String, required: true },
    createdAt: { type: Number, default: Date.now }
}));

// ---------- MULTIPLE ACCOUNT DETECTION (1 device = 1 account) ----------
const DEVICE_LOCK = true;   // false = detection band
const FP_LOCK = true;       // phone fingerprint se bhi block. Galat block par admin "Allow Device" use kare.

const Device = mongoose.model('Device', new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    fp: { type: String, default: '', index: true },
    fp2: { type: String, default: '', index: true },
    ip: { type: String, default: '' },
    createdAt: { type: Number, default: Date.now },
    lastSeen: { type: Number, default: Date.now }
}));

const conflictLogged = new Set();

function normIp(ip) {
    ip = String(ip || '').replace(/^::ffff:/, '');
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
    return ip;
}

// returns null (ok) | 'conflict' | 'missing'   ("pehla account jeetta hai")
async function deviceConflict(userId, deviceId, fp, fp2, ip, skipFp) {
    if (!deviceId || deviceId.length < 8 || deviceId.length > 100) return 'missing';

    const or = [{ deviceId }];
    // Fingerprint tabhi match maana jayega jab fp + fp2 + ip TEENO same hon.
    // (Pehle akela fp, ya fp2+ip match par block hota tha: same model ke phones, same WiFi ya carrier IP par galat block aata tha.)
    if (FP_LOCK && !skipFp && fp && fp2 && ip) or.push({ fp, fp2, ip });

    const others = await Device.find({ userId: { $ne: userId }, $or: or }, { userId: 1, deviceId: 1, createdAt: 1 });
    const mine = await Device.findOne({ deviceId, userId });

    if (others.length) {
        const oldestOther = Math.min(...others.map(o => o.createdAt));
        if (!mine || mine.createdAt >= oldestOther) {
            // Admin ke liye log: kis account se kyun match hua (har pair ek hi baar)
            const first = others.find(o => o.createdAt === oldestOther) || others[0];
            const lk = userId + '>' + first.userId;
            if (!conflictLogged.has(lk)) {
                if (conflictLogged.size > 5000) conflictLogged.clear();
                conflictLogged.add(lk);
                console.log(`🚫 Multi-account: user ${userId} blocked, matches older user ${first.userId} (${others.some(o => o.deviceId === deviceId) ? 'same deviceId' : 'same fingerprint + IP'})`);
            }
            return 'conflict';
        }
    }

    if (!mine) {
        try { await Device.create({ deviceId, userId, fp, fp2, ip }); }
        catch (e) {
            const d = await Device.findOne({ deviceId });
            if (d && d.userId !== userId) return 'conflict';
        }
    } else if (mine.fp !== fp || mine.fp2 !== fp2 || mine.ip !== ip) {
        await Device.updateOne({ deviceId, userId }, { $set: { fp, fp2, ip, lastSeen: Date.now() } });
    }
    return null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
    console.log('Error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// ---------- RATE LIMIT / REPLAY PROTECTION / LOCKS ----------
const rlMap = new Map();
function rl(key, max, win) {
    const now = Date.now();
    let e = rlMap.get(key);
    if (!e || now - e.t > win) { e = { n: 0, t: now }; rlMap.set(key, e); }
    e.n++;
    return e.n <= max;
}

const nonces = new Map();      // nonce -> expiry
const guardAt = new Map();     // userId -> last channel-check time (tap ke liye cache)
const meCheckAt = new Map();   // userId -> last background channel-check time (/api/me ke liye)
const NONCE_TTL = 20 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of rlMap) if (now - e.t > 120000) rlMap.delete(k);
    for (const [k, t] of nonces) if (t < now) nonces.delete(k);
    for (const [k, t] of guardAt) if (now - t > 3600000) guardAt.delete(k);
    for (const [k, t] of meCheckAt) if (now - t > 3600000) meCheckAt.delete(k);
}, 60000).unref();

// Ek user ke tap requests ek ke baad ek chalte hain (double-credit / race se bachao)
const locks = new Map();
async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const cur = new Promise(r => { release = r; });
    const chain = prev.then(() => cur);
    locks.set(key, chain);
    await prev;
    try { return await fn(); }
    finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}

async function tg(method, body) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        return await r.json();
    } catch (e) {
        console.log('Telegram error:', method, e.message);
        return { ok: false, description: e.message };
    }
}

const sendMsg = (chat_id, text, reply_markup, html = true) =>
    tg('sendMessage', { chat_id, text, reply_markup, ...(html ? { parse_mode: 'HTML' } : {}) });

// Welcome: pehle image/GIF + caption (text + buttons). Image fail ho to sirf text bhej do.
async function sendWelcome(chatId, reply_markup) {
    if (WELCOME_IMG) {
        const isGif = /\.(gif|mp4)(\?.*)?$/i.test(WELCOME_IMG);
        const r = await tg(isGif ? 'sendAnimation' : 'sendPhoto', {
            chat_id: chatId,
            [isGif ? 'animation' : 'photo']: WELCOME_IMG,
            caption: WELCOME_TEXT,        // caption limit 1024 chars (abhi ~400)
            parse_mode: 'HTML',
            reply_markup
        });
        if (r.ok) return r;
        console.log('Welcome image failed, sending text only:', r.description || '');
    }
    return sendMsg(chatId, WELCOME_TEXT, reply_markup);
}

// true = member, false = not member, null = Telegram error
async function isMember(channel, userId) {
    const r = await tg('getChatMember', { chat_id: channel, user_id: Number(userId) });
    if (!r.ok) {
        console.log('getChatMember failed for', channel, r.description || '');
        return null;
    }
    const s = r.result.status;
    return ['member', 'administrator', 'creator'].includes(s) || (s === 'restricted' && r.result.is_member === true);
}

// SPEED: dono channels ek saath (parallel) check hote hain
async function checkVerifyChannels(userId) {
    const results = await Promise.all(VERIFY_CHANNELS.map(ch => isMember(ch.id, userId)));
    if (results.some(m => m === null)) return { error: 'Channel check failed' };
    const missing = VERIFY_CHANNELS.filter((ch, i) => !results[i]).map(ch => ch.name);
    return { ok: missing.length === 0, missing };
}

// user verified ho + abhi bhi required channels mein ho. Fail par error string, pass par null.
async function telegramGuard(user) {
    if (!user.isVerified) return 'Please verify channels first.';
    const c = await checkVerifyChannels(user.id);
    if (c.error) return 'Could not verify right now, please try again shortly';
    if (!c.ok) {
        await User.updateOne({ id: user.id }, { isVerified: false });
        guardAt.delete(user.id);
        return 'Must join all channels and tap Check again.';
    }
    return null;
}

// Tap ke liye: har batch par Telegram call nahi, 5 minute me ek baar channel check
async function guardCached(user) {
    if (Date.now() - (guardAt.get(user.id) || 0) < 5 * 60 * 1000) return null;
    const g = await telegramGuard(user);
    if (!g) guardAt.set(user.id, Date.now());
    return g;
}

function validateInitData(initData) {
    if (!initData || initData.length > 4096) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
    try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

function displayName(u) { return u.username ? `@${u.username}` : (u.first_name || 'User'); }

async function auth(req, res, next) {
    try {
        // Database abhi connect nahi hua to saaf message do (crash ya 404 nahi)
        if (!dbReady()) return res.status(503).json({ ok: false, error: 'Server is starting, please try again in a minute' });

        // IP level rate limit
        if (!rl('ip:' + req.ip, 600, 60000)) return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });

        const u = validateInitData(req.headers['x-init-data']);
        if (!u || !u.id) return res.status(401).json({ ok: false, error: 'Please open via bot.' });
        const id = String(u.id);

        // Replay protection: fresh timestamp + ek nonce sirf ek baar
        const ts = Number(req.headers['x-ts']);
        const nonce = String(req.headers['x-nonce'] || '');
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 15 * 60 * 1000) {
            return res.status(400).json({ ok: false, error: 'Please set your phone date & time to automatic and reopen the app.' });
        }
        if (nonce.length < 8 || nonce.length > 64 || nonces.has(id + ':' + nonce) || nonces.size > 300000) {
            return res.status(400).json({ ok: false, error: 'Invalid request. Please reopen the app.' });
        }
        nonces.set(id + ':' + nonce, Date.now() + NONCE_TTL);

        // User level rate limit
        if (!rl('u:' + id, 150, 60000)) return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });

        // FIX: upsert race (E11000) par dobara try, 500 error nahi
        let user;
        try {
            user = await User.findOneAndUpdate(
                { id },
                { $set: { username: displayName(u) } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        } catch (e) {
            if (e && e.code === 11000) {
                user = await User.findOneAndUpdate({ id }, { $set: { username: displayName(u) } }, { new: true });
            } else throw e;
        }
        if (!user) return res.status(500).json({ ok: false, error: 'Server error' });
        if (user.isBanned) return res.status(403).json({ ok: false, banned: true, error: 'Your account is banned.' });

        if (DEVICE_LOCK) {
            const dev = await deviceConflict(
                id,
                String(req.headers['x-device-id'] || '').trim(),
                String(req.headers['x-device-fp'] || '').trim().slice(0, 64),
                String(req.headers['x-device-fp2'] || '').trim().slice(0, 64),
                normIp(req.ip),
                !!user.deviceOk
            );
            if (dev === 'conflict') {
                return res.status(403).json({ ok: false, code: 'MULTI_ACCOUNT', error: 'Multiple account detected. Only one account per device is allowed.' });
            }
            if (dev === 'missing') {
                return res.status(400).json({ ok: false, error: 'Please reopen the app from the bot.' });
            }
        }

        req.user = user;
        next();
    } catch (e) {
        console.log('Auth error:', e);
        res.status(500).json({ ok: false, error: 'Server error' });
    }
}

// Aaj ka tap state (naya UTC din = reset)
function tapState(u) {
    const same = u.tapDay === utcDay();
    return { done: same ? u.tapDone : 0, line: same ? u.tapLine : 0, next: same ? u.tapNext : 0 };
}

// Referral list saaf karke bhejo (purani/kharab entries ko theek ya hata do)
function cleanReferrals(list) {
    return (Array.isArray(list) ? list : []).map(r => {
        r = r || {};
        const id = r.id || r.userId || r.uid || r.user;
        if (!id) return null;
        const bonus = Number(r.bonus || r.amount);
        return {
            id: String(id),
            date: r.date || r.createdAt || r.time || null,
            bonus: Number.isFinite(bonus) && bonus > 0 ? bonus : fromMicro(REF_BONUS),
            status: 'COMPLETED'
        };
    }).filter(Boolean);
}

// proof: { task, status: 'ready' } => frontend Submit ki jagah Claim button dikhaye
function publicUser(u, pending) {
    const t = tapState(u);
    return {
        id: u.id,
        username: u.username,
        balance: fromMicro(u.balance),
        serverTime: Date.now(),
        isVerified: u.isVerified,
        rules: { minWithdraw: fromMicro(MIN_WITHDRAW), minRefs: MIN_REFS },
        tasks: {
            tg2: !!(u.tasks && u.tasks.tg2),
            yt1: !!(u.tasks && u.tasks.yt1),
            yt2: !!(u.tasks && u.tasks.yt2)
        },
        tap: {
            done: t.done,
            max: ROUNDS_PER_DAY,
            target: TAP_TARGET,
            perTap: ROUND_REWARD / TAP_TARGET / U,
            lineTaps: t.line,
            cooldown: COOLDOWN,
            nextTime: t.next
        },
        daily: { claimed: u.dailyDay === utcDay(), reward: fromMicro(DAILY_BONUS) },
        proof: pending ? { task: pending.task, status: 'ready' } : null,
        referrals: cleanReferrals(u.referrals),
        withdrawals: (Array.isArray(u.withdrawals) ? u.withdrawals : []).slice(0, 50)
    };
}

// User ka view. Team DB se banti hai: sirf VERIFIED friends (purane bhi) dikhte hain.
async function userView(u) {
    const p = await PendingClaim.findOne({ userId: u.id });
    const view = publicUser(u, p);
    const paid = new Map(cleanReferrals(u.referrals).map(r => [r.id, r]));
    const team = await User.find({ referredBy: u.id, isVerified: true }, { id: 1, createdAt: 1 })
        .sort({ createdAt: -1 }).limit(500).lean();
    const seen = new Set();
    const list = [];
    team.forEach(t => {
        seen.add(t.id);
        const r = paid.get(t.id);
        list.push({ id: t.id, date: r ? r.date : t.createdAt, bonus: r ? r.bonus : 0, status: 'COMPLETED' });
    });
    paid.forEach((r, id) => { if (!seen.has(id)) list.push(r); });
    view.referrals = list;
    return view;
}

// ---------- USER STATS (admin ko withdraw request me dikhane ke liye) ----------
// refs = VERIFIED referrals ki ginti, totalWithdrawn = ab tak paid total, paidCount = kitni baar paid hua
async function userStats(userId) {
    const id = String(userId);
    const [refs, u] = await Promise.all([
        User.countDocuments({ referredBy: id, isVerified: true }),
        User.findOne({ id }, { totalWithdrawn: 1, withdrawals: 1 }).lean()
    ]);
    const w = Array.isArray(u && u.withdrawals) ? u.withdrawals : [];
    return {
        refs,
        totalWithdrawn: (u && Number(u.totalWithdrawn)) || 0,
        paidCount: w.filter(x => x && String(x.status).toUpperCase() === 'PAID').length
    };
}
const statsLine = s =>
    `👥 Verified Referrals: <b>${s.refs}</b>\n` +
    `📤 Total Withdrawn: <b>${fmtD(s.totalWithdrawn)} ${COIN}</b> (${s.paidCount} paid)`;

// ---------- REFERRAL CREDIT (FIXED) ----------
// Naya user verify hote hi referrer ko bonus + notification milta hai.
// Sirf ek baar credit hota hai (refCredited flag se atomic claim). Fail par flag wapas false.
async function creditReferral(userId) {
    const u = await User.findOne({ id: String(userId) });
    if (!u || !u.isVerified || !u.referredBy || u.referredBy === u.id) return false;
    const refId = u.referredBy;

    // Referrer ki referrals field array na ho to [] bana do (purana data)
    await User.collection.updateOne(
        { id: refId, referrals: { $not: { $type: 'array' } } },
        { $set: { referrals: [] } }
    );

    const refDoc = await User.findOne({ id: refId }, { referrals: 1 }).lean();
    if (!refDoc) return false;
    const inList = (Array.isArray(refDoc.referrals) ? refDoc.referrals : [])
        .some(r => r && String(r.id) === u.id);
    if (inList) {
        if (!u.refCredited) await User.updateOne({ id: u.id }, { $set: { refCredited: true } });
        return false;
    }

    // atomic claim: sirf ek request credit kar sakti hai
    const claim = await User.findOneAndUpdate(
        { id: u.id, refCredited: { $ne: true } },
        { $set: { refCredited: true } }
    );
    if (!claim) return false;

    try {
        const ref = await User.findOneAndUpdate({ id: refId }, {
            $inc: { balance: REF_BONUS },
            $push: { referrals: { id: u.id, date: new Date().toISOString(), bonus: fromMicro(REF_BONUS), status: 'COMPLETED' } }
        }, { new: true });
        if (!ref) throw new Error('referrer not found');

        console.log(`✅ Referral credited: ${u.id} -> ${ref.id}`);

        sendMsg(ref.id,
            `🎉 <b>New Referral Joined!</b>\n\n` +
            `👥 A new user has successfully joined through your referral link.\n\n` +
            `💰 <b>${fmtD(REF_BONUS)} ${COIN.toUpperCase()}</b> has been added to your balance!\n\n` +
            `🚀 Keep inviting friends and earn more Baby Doge!`
        ).then(r => { if (!r.ok) console.log('Referral notify failed:', r.description || ''); });

        return true;
    } catch (e) {
        // rollback: agli baar dobara try ho sake
        await User.updateOne({ id: u.id }, { $set: { refCredited: false } });
        throw e;
    }
}

// Referrer ke purane verified friends jinka bonus reh gaya ho, unhe ek baar credit karo (idempotent)
async function creditPendingForReferrer(refId) {
    const kids = await User.find({ referredBy: String(refId), isVerified: true }, { id: 1 }).limit(500).lean();
    if (!kids.length) return;
    const me = await User.findOne({ id: String(refId) }, { referrals: 1 }).lean();
    const have = new Set(cleanReferrals(me && me.referrals).map(r => r.id));
    for (const k of kids) if (!have.has(k.id)) await creditReferral(k.id);
}

// CORS: mini app kisi bhi host se khule, API calls kaam karein
app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-init-data, x-device-id, x-device-fp, x-device-fp2, x-ts, x-nonce');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send(dbReady() ? 'OK' : 'OK (database connecting)'));
app.get('/api/ping', (req, res) => res.json({ ok: true, db: dbReady(), version: 'babydoge-tapfi-v5-fast' }));

// ---------- USER API ----------

// SPEED: channel check + referral steps ab BACKGROUND me chalte hain (response ka intezar nahi).
// App 2 second me khulti hai. Check har user ke liye 5 minute me ek baar hota hai.
async function backgroundVerifyCheck(userId, hasReferrer) {
    try {
        const r = await checkVerifyChannels(userId);
        if (r.ok === false) {
            await User.updateOne({ id: userId }, { isVerified: false });
            guardAt.delete(userId);
        } else if (r.ok === true) {
            try {
                if (hasReferrer) await creditReferral(userId);
                await creditPendingForReferrer(userId);
            } catch (e) { console.log('Referral step error (ignored):', e.message); }
        }
        // r.error (Telegram issue) par verified status chhedna nahi
    } catch (e) { console.log('Background channel check error (ignored):', e.message); }
}

app.post('/api/me', auth, wrap(async (req, res) => {
    const u = req.user;
    if (u.isVerified && Date.now() - (meCheckAt.get(u.id) || 0) > 5 * 60 * 1000) {
        meCheckAt.set(u.id, Date.now());
        backgroundVerifyCheck(u.id, !!u.referredBy);   // await nahi: fire and forget
    }
    let data;
    try {
        data = await userView(u);
    } catch (e) {
        // team list fail ho to bhi basic data bhejo
        console.log('userView error, using basic view:', e.message);
        data = publicUser(u, null);
    }
    res.json({ ok: true, data });
}));

app.post('/api/verify', auth, wrap(async (req, res) => {
    const u = req.user;
    const r = await checkVerifyChannels(u.id);
    if (r.error) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!r.ok) return res.json({ ok: false, missing: r.missing, error: 'Must join all channels and tap Check again.' });

    await User.updateOne({ id: u.id }, { isVerified: true });
    meCheckAt.set(u.id, Date.now());

    // Joining bonus: sirf ek baar
    const jb = await User.findOneAndUpdate(
        { id: u.id, joinBonus: { $ne: true } },
        { $set: { joinBonus: true }, $inc: { balance: JOIN_BONUS } }
    );
    const gotJoin = !!jb;

    // FIX: referral fail ho to bhi verify success hona chahiye
    try { await creditReferral(u.id); }
    catch (e) { console.log('creditReferral error (ignored):', e.message); }

    const fresh = await User.findOne({ id: u.id });
    let data;
    try { data = await userView(fresh); }
    catch (e) { console.log('userView error in verify:', e.message); data = publicUser(fresh, null); }
    res.json({ ok: true, joinBonus: gotJoin, data });
}));

// ---------- TAP (har tap par BabyDoge) ----------
app.post('/api/tap', auth, wrap(async (req, res) => {
    const id = req.user.id;
    const taps = Math.floor(Number(req.body.taps));
    if (!Number.isFinite(taps) || taps < 1 || taps > 60) return res.json({ ok: false, error: 'Invalid request' });

    const r = await withLock(id, async () => {
        const u = await User.findOne({ id });
        if (!u || !u.isVerified) return { error: 'Please verify channels first.' };

        const g = await guardCached(u);
        if (g) return { error: g };

        const now = Date.now();
        const today = utcDay(now);
        const t = tapState(u);

        if (t.done >= ROUNDS_PER_DAY) return { error: 'Daily limit reached. Come back tomorrow!', u };
        if (now < t.next) return { error: 'Wait for the next line.', u };

        // insani raftaar: pichle batch ke baad itne seconds me itne hi taps possible
        const elapsed = Math.min(now - (u.lastTapAt || 0), 10000);
        const allowed = Math.floor(elapsed / 1000 * MAX_TPS) + 5;
        const n = Math.min(taps, allowed, TAP_TARGET - t.line);
        if (n <= 0) return { u };

        const newLine = t.line + n;
        // cumulative integer formula: 30 taps ka total hamesha exact ROUND_REWARD
        const credit = Math.floor(newLine * ROUND_REWARD / TAP_TARGET) - Math.floor(t.line * ROUND_REWARD / TAP_TARGET);
        const completed = newLine >= TAP_TARGET;

        const upd = await User.findOneAndUpdate(
            { id },
            {
                $set: {
                    tapDay: today,
                    tapDone: completed ? t.done + 1 : t.done,
                    tapLine: completed ? 0 : newLine,
                    tapNext: completed ? now + COOLDOWN : t.next,
                    lastTapAt: now
                },
                $inc: { balance: credit }
            },
            { new: true }
        );
        return { u: upd };
    });

    if (r.error) {
        return res.json({ ok: false, error: r.error, ...(r.u ? { data: await userView(r.u) } : {}) });
    }
    res.json({ ok: true, data: await userView(r.u) });
}));

// Telegram Channel 2 task: membership server check karta hai
app.post('/api/task', auth, wrap(async (req, res) => {
    const u = req.user;
    const taskId = String(req.body.taskId || '');
    if (taskId !== 'tg2') return res.json({ ok: false, error: 'Invalid task' });
    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });

    const m = await isMember(TASK_CHANNEL.id, u.id);
    if (m === null) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!m) return res.json({ ok: false, error: 'Please join the channel first!' });

    const done = await User.findOneAndUpdate(
        { id: u.id, 'tasks.tg2': { $ne: true } },
        { $set: { 'tasks.tg2': true }, $inc: { balance: TASK_REWARD } },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Task already claimed.' });
    res.json({ ok: true, data: await userView(done) });
}));

// ---------- DAILY BONUS (500K, din me ek baar) ----------
app.post('/api/daily', auth, wrap(async (req, res) => {
    const u = req.user;
    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });
    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const today = utcDay();
    const done = await User.findOneAndUpdate(
        { id: u.id, dailyDay: { $ne: today } },
        { $set: { dailyDay: today }, $inc: { balance: DAILY_BONUS } },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Daily bonus already claimed. Come back tomorrow!' });
    res.json({ ok: true, data: await userView(done) });
}));

// ---------- YOUTUBE TASKS (Open -> Submit -> Claim) ----------

async function ytSubmit(req, res) {
    const u = req.user;
    const taskId = String(req.body.taskId || '');
    if (!YT_TASKS.includes(taskId)) return res.json({ ok: false, error: 'Invalid task' });

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    if (u.tasks && u.tasks[taskId]) return res.json({ ok: false, error: 'Task already claimed.' });

    const existing = await PendingClaim.findOne({ userId: u.id });
    if (existing) {
        if (existing.task === taskId) {
            return res.json({ ok: true, alreadySubmitted: true, data: await userView(u) });
        }
        return res.json({ ok: false, error: 'Please claim your pending reward first.', data: await userView(u) });
    }

    try {
        await PendingClaim.create({ userId: u.id, task: taskId, createdAt: Date.now() });
    } catch (e) {
        return res.json({ ok: false, error: 'Please claim your pending reward first.' });
    }
    res.json({ ok: true, data: await userView(u) });
}

async function ytClaim(req, res) {
    const u = req.user;

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const pending = await PendingClaim.findOne({ userId: u.id });
    if (!pending) return res.json({ ok: false, error: 'Nothing to claim. Tap Submit first.' });

    const wait = pending.createdAt + YT_CLAIM_DELAY - Date.now();
    if (wait > 0) {
        return res.json({ ok: false, error: `Please wait ${Math.ceil(wait / 1000)}s and try again.` });
    }

    const pr = await PendingClaim.findOneAndDelete({ userId: u.id, task: pending.task });
    if (!pr) return res.json({ ok: false, error: 'Nothing to claim. Tap Submit first.' });

    const key = `tasks.${pr.task}`;
    const done = await User.findOneAndUpdate(
        { id: u.id, [key]: { $ne: true } },
        { $set: { [key]: true }, $inc: { balance: TASK_REWARD } },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Task already claimed.' });
    res.json({ ok: true, data: await userView(done) });
}

app.post('/api/yt/submit', auth, wrap(ytSubmit));
app.post('/api/yt/claim', auth, wrap(ytClaim));
app.post('/api/proof/start', auth, wrap(ytSubmit));
app.post('/api/proof/claim', auth, wrap(ytClaim));

// ---------- WITHDRAW (BabyDoge BEP-20: manual wallet address) ----------
const adminButtons = reqId => ({ inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]] });

// Admin ko naya withdraw request: user ke total referrals + total withdrawn ke saath
async function notifyAdminRequest(reqId, user, amt, address) {
    let st = '';
    try { st = '\n' + statsLine(await userStats(user.id)); } catch (e) { console.log('userStats error:', e.message); }
    await sendMsg(ADMIN_ID,
        `📤 <b>New Withdraw Request</b>\n\n` +
        `👤 User ID: <code>${esc(user.id)}</code>\n` +
        `💰 Amount: <b>${fmtD(amt)} ${COIN}</b> (BEP-20)\n` +
        `🏦 Address: <code>${esc(address)}</code>` + st,
        adminButtons(reqId)
    );
}

app.post('/api/withdraw', auth, wrap(async (req, res) => {
    const u = req.user;
    if (!rl('wd:' + u.id, 5, 60000)) return res.json({ ok: false, error: 'Too many attempts. Please wait a minute.' });

    const amt = toMicro(req.body.amount);
    const address = String(req.body.address || '').trim();

    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.json({ ok: false, error: 'Invalid BEP-20 wallet address!' });
    if (!Number.isFinite(amt) || amt < MIN_WITHDRAW) return res.json({ ok: false, error: `Minimum withdrawal is ${fmtD(MIN_WITHDRAW)} ${COIN}!` });

    // Kam az kam MIN_REFS VERIFIED referrals zaroori (0 referral par withdraw nahi)
    const refCount = await User.countDocuments({ referredBy: u.id, isVerified: true });
    if (refCount < MIN_REFS) {
        return res.json({ ok: false, error: `You need at least ${MIN_REFS} verified referrals to withdraw. You have ${refCount}.` });
    }

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const addr = address.toLowerCase();
    if (u.wallet && u.wallet !== addr) {
        return res.json({ ok: false, error: 'Withdrawals go only to your first used wallet. Contact support to change it.' });
    }
    if (!u.wallet) {
        try {
            await User.updateOne({ id: u.id, wallet: null }, { $set: { wallet: addr } });
        } catch (e) {
            if (e && e.code === 11000) return res.json({ ok: false, error: 'This wallet is already linked to another account.' });
            throw e;
        }
        const fresh = await User.findOne({ id: u.id });
        if (!fresh || fresh.wallet !== addr) return res.json({ ok: false, error: 'Withdrawals go only to your first used wallet.' });
    }

    const reqId = 'wd_' + crypto.randomBytes(6).toString('hex');

    try {
        await PendingRequest.create({ reqId, userId: u.id, amount: amt, address });
    } catch (e) {
        return res.json({ ok: false, error: 'You already have a pending withdrawal request.' });
    }

    let upd;
    try {
        upd = await User.findOneAndUpdate(
            { id: u.id, balance: { $gte: amt } },
            {
                $inc: { balance: -amt },
                $push: { withdrawals: { $each: [{ id: reqId, amount: fromMicro(amt), address, status: 'PENDING', date: new Date().toISOString() }], $position: 0 } }
            },
            { new: true }
        );
    } catch (e) {
        await PendingRequest.deleteOne({ reqId });
        throw e;
    }
    if (!upd) {
        await PendingRequest.deleteOne({ reqId });
        return res.json({ ok: false, error: 'Insufficient balance!' });
    }

    const view = await userView(upd);

    // AUTO PAYOUT
    if (AUTO_PAYOUT && payoutReady() && amt <= MAX_AUTO_PAYOUT) {
        res.json({ ok: true, data: view });
        autoPayout(reqId, u.id, amt, address).catch(e => console.log('autoPayout error:', e));
        return;
    }

    // MANUAL: admin approve karega
    res.json({ ok: true, data: view });
    notifyAdminRequest(reqId, u, amt, address).catch(e => console.log('notifyAdminRequest error:', e.message));
}));

async function autoPayout(reqId, userId, amt, address) {
    const r = await resolveWithdraw(reqId, true);
    let st = '';
    try { st = '\n' + statsLine(await userStats(userId)); } catch (e) { console.log('userStats error:', e.message); }
    if (r.ok) {
        sendMsg(ADMIN_ID, `🤖 <b>Auto payout sent</b>\n\n👤 User ID: <code>${esc(userId)}</code>\n💰 ${fmtD(amt)} ${COIN} (BEP-20)\n🏦 <code>${esc(address)}</code>` +
            (r.txHash ? `\n🔗 https://bscscan.com/tx/${esc(r.txHash)}` : '') + st);
    } else {
        sendMsg(ADMIN_ID,
            `⚠️ <b>Auto payout failed</b>\n\n👤 User ID: <code>${esc(userId)}</code>\n💰 ${fmtD(amt)} ${COIN} (BEP-20)\n🏦 <code>${esc(address)}</code>` + st +
            `\n\nReason: ${esc(r.message || 'unknown')}` +
            (r.restored ? '\n\nRequest is pending. Fix the issue and approve manually, or reject to refund.' : ''),
            r.restored ? adminButtons(reqId) : undefined
        );
    }
}

// ---------- WITHDRAW RESOLVE ----------

async function markPaid(pr, txHash) {
    const set = { 'withdrawals.$[w].status': 'PAID' };
    if (txHash) set['withdrawals.$[w].tx'] = txHash;
    const paidUser = await User.findOneAndUpdate(
        { id: pr.userId },
        { $set: set, $inc: { totalWithdrawn: pr.amount } },
        { arrayFilters: [{ 'w.id': pr.reqId }], new: true }
    );
    sendMsg(pr.userId, `✅ Your withdrawal of <b>${fmtD(pr.amount)} ${COIN}</b> has been paid!` +
        (txHash ? `\n🔗 <a href="https://bscscan.com/tx/${esc(txHash)}">View transaction</a>` : ''));

    // Auto payment proof: channel me username + ID + amount + address post hota hai
    const uname = paidUser && paidUser.username ? paidUser.username : 'User';
    sendMsg(PAYMENT_CHANNEL,
        `✅ <b>New Payment Sent!</b>\n\n` +
        `👤 User: <b>${esc(uname)}</b>\n` +
        `🆔 ID: <code>${esc(pr.userId)}</code>\n` +
        `💰 Amount: <b>${fmtD(pr.amount)} ${COIN}</b> (BEP-20)\n` +
        `🏦 Address: <code>${esc(pr.address)}</code>\n` +
        (txHash ? `🔗 <a href="https://bscscan.com/tx/${esc(txHash)}">Transaction</a>\n` : '') +
        `\n🚀 Earn free ${COIN} with @${BOT_USERNAME}`
    ).then(r => { if (!r.ok) console.log('Payment channel post failed:', r.description || ''); });
}

// Payout fail hone par request wapas pending me (agar user ne beech me nayi request na bana li ho), warna refund
async function restorePending(pr) {
    try {
        await PendingRequest.create({ reqId: pr.reqId, userId: pr.userId, amount: pr.amount, address: pr.address });
        return true;
    } catch (e) {
        await User.updateOne(
            { id: pr.userId },
            { $set: { 'withdrawals.$[w].status': 'DECLINED' }, $inc: { balance: pr.amount } },
            { arrayFilters: [{ 'w.id': pr.reqId }] }
        );
        sendMsg(pr.userId, `❌ Your withdrawal of <b>${fmtD(pr.amount)} ${COIN}</b> could not be processed and the amount was refunded.`);
        return false;
    }
}

async function resolveWithdraw(reqId, approve) {
    const pr = await PendingRequest.findOneAndDelete({ reqId: String(reqId) });
    if (!pr) return { ok: false, message: 'Request already handled / not found' };

    let txHash = null;
    if (approve) {
        if (payoutReady()) {
            try {
                // ek waqt me ek hi on-chain payment (nonce clash se bachao)
                const out = await withLock('payout', () => sendToken(pr.address, pr.amount));
                txHash = out.hash;
            } catch (e) {
                console.log('Payout failed:', e.message);
                const restored = await restorePending(pr);
                return { ok: false, restored, message: 'Payout failed: ' + String(e.shortMessage || e.message).slice(0, 150) };
            }
        }
        await markPaid({ reqId: String(reqId), userId: pr.userId, amount: pr.amount, address: pr.address }, txHash);
    } else {
        await User.updateOne(
            { id: pr.userId },
            { $set: { 'withdrawals.$[w].status': 'DECLINED' }, $inc: { balance: pr.amount } },
            { arrayFilters: [{ 'w.id': String(reqId) }] }
        );
        sendMsg(pr.userId, `❌ Your withdrawal of <b>${fmtD(pr.amount)} ${COIN}</b> was declined and the amount was refunded.`);
    }
    return { ok: true, pr, txHash };
}

// ---------- TELEGRAM WEBHOOK ----------

app.post('/api/webhook', async (req, res) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.sendStatus(403);
    res.sendStatus(200);

    try {
        const update = req.body;

        if (update.message && update.message.text !== undefined) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const text = msg.text || '';
            if (msg.chat.type !== 'private') return;

            const known = await User.findOne({ id: chatId });
            if (known && known.isBanned) return sendMsg(chatId, '⚠️ <b>Access Denied:</b> Your account has been banned.');

            if (text.startsWith('/start')) {
                console.log('📩 /start received from', chatId, 'text:', JSON.stringify(text));
                // /start 123456  |  /start ref123456  |  /start ref_123456  |  /start@Bot 123456
                const m = text.match(/^\/start(?:@\w+)?\s+(?:ref_?)?(\d{1,20})\s*$/i);
                let referrer = m ? m[1] : null;
                if (referrer === chatId) referrer = null;
                if (referrer && !(await User.exists({ id: referrer }))) {
                    console.log('Referral: referrer not found in DB', referrer);
                    referrer = null;
                }

                const name = displayName(msg.from);
                let user;
                try {
                    user = await User.findOneAndUpdate(
                        { id: chatId },
                        { $set: { username: name } },
                        { upsert: true, new: true, setDefaultsOnInsert: true }
                    );
                } catch (e) {
                    if (e && e.code === 11000) user = await User.findOneAndUpdate({ id: chatId }, { $set: { username: name } }, { new: true });
                    else throw e;
                }
                // Referrer sirf link hota hai (bonus nahi). Bonus verification success par milta hai.
                if (referrer && user && !user.referredBy && !user.isVerified) {
                    await User.updateOne({ id: chatId, referredBy: null }, { $set: { referredBy: referrer } });
                    console.log(`Referral linked: ${chatId} <- ${referrer}`);
                }

                // Har channel ka button alag row me (poori width)
                const kb = [
                    [{ text: '📢 Official Updates Channel', url: CHANNEL_UPDATES.url }],
                    [{ text: '💸 Official Payouts Channel', url: CHANNEL_PAYOUTS.url }]
                ];
                // Image/GIF + welcome text + buttons
                await sendWelcome(chatId, { inline_keyboard: kb });
            } else if (text === '/admin' && chatId === ADMIN_ID) {
                await sendMsg(chatId, '👑 <b>BabyDoge TapFi Admin</b>',
                    PUBLIC_URL ? { inline_keyboard: [[{ text: '🔐 Admin Login Panel', url: `${PUBLIC_URL}/admin/login` }]] } : undefined);
            }

        } else if (update.callback_query) {
            const q = update.callback_query;
            const chatId = String(q.message.chat.id);
            const data = q.data || '';

            const m = data.match(/^(approve|reject)_(wd_[a-f0-9]+)$/);
            if (!m) return;

            if (chatId !== ADMIN_ID) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Unauthorized!' });

            const approve = m[1] === 'approve';
            const r = await resolveWithdraw(m[2], approve);
            if (!r.ok) return tg('answerCallbackQuery', { callback_query_id: q.id, text: String(r.message || 'Already handled!').slice(0, 190), show_alert: true });

            tg('editMessageText', {
                chat_id: chatId,
                message_id: q.message.message_id,
                parse_mode: 'HTML',
                text: `${approve ? '✅ <b>Approved</b>' : '❌ <b>Rejected</b>'}\nUser ID: ${esc(r.pr.userId)}\nAmount: ${fmtD(r.pr.amount)} ${COIN}`
            });
            tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Done!' });
        }
    } catch (e) {
        console.log('Webhook error:', e);
    }
});

// ---------- ADMIN PANEL ----------

const sessions = new Map();
const attempts = new Map();
const parseCookies = h => Object.fromEntries(
    (h || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(p => [p[0], decodeURIComponent(p.slice(1).join('='))])
);
const safeEq = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
};

function checkAdmin(req, res, next) {
    const t = parseCookies(req.headers.cookie).admin_session;
    if (t && sessions.has(t) && sessions.get(t) > Date.now()) return next();
    if (req.method === 'GET') return res.redirect('/admin/login');
    return res.status(401).json({ ok: false, message: 'Not logged in' });
}

app.get('/admin/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Admin Login</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:#05080f;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{background:#0c121d;border:1px solid #1d2a40;padding:30px;border-radius:16px;width:90%;max-width:360px;text-align:center}h2{color:#19f5a5}input{width:100%;padding:12px;margin-bottom:12px;background:#05080f;border:1px solid #2a3a55;color:#fff;border-radius:8px}button{width:100%;padding:12px;background:#19f5a5;color:#031410;font-weight:bold;border:none;border-radius:8px;cursor:pointer}</style></head>
<body><div class="c"><h2>🔐 BabyDoge TapFi Admin</h2><form action="/admin/login" method="POST"><input name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button>Login</button></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
    const ip = req.ip;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 5) return res.status(429).send('Too many attempts. Try again in 15 minutes.');

    const { username = '', password = '' } = req.body;
    if (safeEq(username, ADMIN_USERNAME) && safeEq(password, ADMIN_PASSWORD)) {
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 24 * 3600 * 1000);
        res.setHeader('Set-Cookie',
            `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${PUBLIC_URL.startsWith('https') ? '; Secure' : ''}`);
        return res.redirect('/admin/dashboard');
    }
    a.n++;
    attempts.set(ip, a);
    res.send(`<script>alert('Invalid Credentials!');location.href='/admin/login'</script>`);
});

app.get('/admin/logout', (req, res) => {
    const t = parseCookies(req.headers.cookie).admin_session;
    if (t) sessions.delete(t);
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdmin, wrap(async (req, res) => {
    const [totalUsers, verified, pending, agg] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ isVerified: true }),
        PendingRequest.find({}).sort({ _id: -1 }),
        User.aggregate([{ $group: { _id: null, bal: { $sum: '$balance' }, paid: { $sum: '$totalWithdrawn' } } }])
    ]);
    const s = agg[0] || { bal: 0, paid: 0 };
    const whi = await tg('getWebhookInfo', {});
    const wh = whi.ok ? whi.result : {};
    const q = String(req.query.search || '').trim().slice(0, 64);
    const found = q ? await User.findOne({ $or: [{ id: q }, { username: q.startsWith('@') ? q : '@' + q }] }) : null;

    // Har pending request ke user ke referrals + total withdrawn
    const pStats = await Promise.all(pending.map(r =>
        userStats(r.userId).catch(() => ({ refs: 0, totalWithdrawn: 0, paidCount: 0 }))
    ));

    const reqRows = pending.map((r, i) => `<tr><td>${esc(r.userId)}</td><td><b>${fmtD(r.amount)} ${COIN}</b></td><td>${pStats[i].refs}</td><td>${fmtD(pStats[i].totalWithdrawn)} (${pStats[i].paidCount})</td><td><code>${esc(r.address)}</code></td>
<td><button class="b g" data-act="req" data-do="approve" data-id="${esc(r.reqId)}">Approve</button> <button class="b r" data-act="req" data-do="reject" data-id="${esc(r.reqId)}">Reject</button></td></tr>`).join('');

    let userBox = '';
    if (found) {
        const ts = tapState(found);
        const fs = await userStats(found.id).catch(() => ({ refs: 0 }));
        userBox = `<div class="box">
<p>👤 <b>${esc(found.username)}</b> | ID: <code>${esc(found.id)}</code></p>
<p>💰 Balance: <b>${fmtD(found.balance)} ${COIN}</b> | 📤 Total Withdrawn: <b>${fmtD(found.totalWithdrawn)} ${COIN}</b></p>
<p>✅ Verified: ${found.isVerified ? 'Yes' : 'No'} | 🚫 Banned: ${found.isBanned ? 'Yes' : 'No'} | 👥 Referrals (verified): ${fs.refs} | Referred by: ${esc(found.referredBy || 'Direct')} | Ref credited: ${found.refCredited ? 'Yes' : 'No'} | Device allowed: ${found.deviceOk ? 'Yes' : 'No'}</p>
<p>👆 Today's lines: ${ts.done} / ${ROUNDS_PER_DAY} | 🏦 Wallet: <code>${esc(found.wallet || 'not linked')}</code></p>
<div class="row"><input type="number" step="any" id="amt" placeholder="Amount (${COIN})">
<button class="b g" data-act="bal" data-do="add" data-uid="${esc(found.id)}">+ Add</button>
<button class="b r" data-act="bal" data-do="cut" data-uid="${esc(found.id)}">- Cut</button>
<button class="b r" data-act="ban" data-do="ban" data-uid="${esc(found.id)}">Ban</button>
<button class="b g" data-act="ban" data-do="unban" data-uid="${esc(found.id)}">Unban</button>
<button class="b" data-act="dev" data-uid="${esc(found.id)}">Reset Device</button>
<button class="b" data-act="wal" data-uid="${esc(found.id)}">Reset Wallet</button>
<button class="b g" data-act="allowdev" data-uid="${esc(found.id)}">Allow Device</button>
<button class="b g" data-act="cref" data-uid="${esc(found.id)}">Credit Referral</button></div>
<div class="row"><input id="smsg" placeholder="Message to this user"><button class="b" data-act="msg" data-uid="${esc(found.id)}">Send</button></div></div>`;
    } else if (q) {
        userBox = '<p style="color:#ef4444">User not found!</p>';
    }

    const payInfo = payoutReady()
        ? `Auto payout: <b>${AUTO_PAYOUT ? 'ON' : 'OFF'}</b> (max ${fmtD(MAX_AUTO_PAYOUT)} ${COIN}) | Wallet: <code>${esc(payoutWallet.address)}</code>`
        : 'Auto payout: <b>not configured</b> (manual approve)';

    res.send(`<!DOCTYPE html><html><head><title>BabyDoge TapFi Admin</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:#05080f;color:#f3f4f6;margin:0;padding:16px}h1{color:#19f5a5;font-size:22px;margin:0}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.lo{background:#ef4444;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:bold}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.st{background:#0c121d;border:1px solid #1d2a40;border-radius:12px;padding:14px}.st small{color:#7e8ba3;font-size:11px;text-transform:uppercase}.st div{font-size:19px;font-weight:bold;color:#19f5a5;margin-top:6px}
.card{background:#0c121d;border:1px solid #1d2a40;border-radius:12px;padding:16px;margin-bottom:16px}.card h3{color:#19f5a5;margin:0 0 10px;font-size:15px}
input,textarea{background:#05080f;border:1px solid #2a3a55;color:#fff;padding:10px;border-radius:8px;width:100%;font-size:14px}.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.row input{flex:1;min-width:120px}
.b{background:#19f5a5;color:#031410;border:none;font-weight:bold;padding:9px 14px;border-radius:8px;cursor:pointer}.b.g{background:#22c55e;color:#fff}.b.r{background:#ef4444;color:#fff}
table{width:100%;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid #1d2a40;font-size:12px;word-break:break-all}th{color:#7e8ba3}.box{background:#05080f;padding:12px;border-radius:8px;border:1px solid #1d2a40;margin-top:10px;font-size:13px;line-height:1.8}</style></head><body>
<div class="top"><h1>👑 BabyDoge TapFi Admin</h1><a class="lo" href="/admin/logout">Logout</a></div>
<p style="font-size:12px;color:#7e8ba3;margin-bottom:6px;word-break:break-all">${payInfo}</p>
<p style="font-size:12px;color:#7e8ba3;margin-bottom:12px;word-break:break-all">Webhook: <code>${esc(wh.url || 'NOT SET')}</code> | Pending: ${esc(wh.pending_update_count || 0)}${wh.last_error_message ? ' | <span style="color:#ef4444">Last error: ' + esc(wh.last_error_message) + '</span>' : ''} | Server: ${esc(PUBLIC_URL || 'PUBLIC_URL not set')}</p>
<div class="grid">
<div class="st"><small>Total Users</small><div>${totalUsers}</div></div>
<div class="st"><small>Verified Users</small><div>${verified}</div></div>
<div class="st"><small>Users' Balance</small><div>${fmtD(s.bal)} ${COIN}</div></div>
<div class="st"><small>Paid Out</small><div>${fmtD(s.paid)} ${COIN}</div></div>
<div class="st"><small>Pending Requests</small><div>${pending.length}</div></div></div>
<div class="card"><h3>⏳ Pending Withdrawal Requests</h3>${pending.length ? `<table><tr><th>User ID</th><th>Amount</th><th>Verified Refs</th><th>Total Withdrawn (paid #)</th><th>Wallet (BEP-20)</th><th>Action</th></tr>${reqRows}</table>` : '<p style="color:#7e8ba3;font-size:12px">No pending requests.</p>'}</div>
<div class="card"><h3>🔍 Search & Manage User</h3><form method="GET" class="row"><input name="search" placeholder="Telegram ID or @username" value="${esc(q)}"><button class="b">Search</button></form>${userBox}</div>
<div class="card"><h3>🛠 Referral Repair</h3><p style="font-size:12px;color:#7e8ba3;margin-bottom:10px">Missed referrals (user verified but referrer got no bonus) ko ek click me theek karo.</p><button class="b g" style="width:100%" data-act="rep">Repair All Referrals</button></div>
<div class="card"><h3>📢 Broadcast</h3><textarea id="bc" rows="3" placeholder="Message to all users..."></textarea><button class="b" style="margin-top:10px;width:100%" data-act="bc">Send Broadcast</button></div>
<script>
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const d=await r.json();alert(d.message||'Done');return d}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;let d;
if(a==='req')d=await post('/admin/action',{reqId:b.dataset.id,action:b.dataset.do});
else if(a==='bal'){const amount=document.getElementById('amt').value;if(!amount)return alert('Enter amount');d=await post('/admin/balance',{userId:b.dataset.uid,amount,action:b.dataset.do})}
else if(a==='ban')d=await post('/admin/ban',{userId:b.dataset.uid,action:b.dataset.do});
else if(a==='dev'){if(!confirm('Reset device lock for this user?'))return;d=await post('/admin/resetdevice',{userId:b.dataset.uid})}
else if(a==='wal'){if(!confirm('Unlink wallet for this user?'))return;d=await post('/admin/resetwallet',{userId:b.dataset.uid})}
else if(a==='rep'){if(!confirm('Repair all missed referrals?'))return;d=await post('/admin/repairrefs',{})}
else if(a==='cref'){d=await post('/admin/creditref',{userId:b.dataset.uid})}
else if(a==='allowdev'){if(!confirm('Allow this user (skip fingerprint/IP matching)?'))return;d=await post('/admin/allowdevice',{userId:b.dataset.uid})}
else if(a==='msg'){const message=document.getElementById('smsg').value;if(!message)return;d=await post('/admin/msg',{userId:b.dataset.uid,message})}
else if(a==='bc'){const message=document.getElementById('bc').value;if(!message)return;if(!confirm('Send to all users?'))return;d=await post('/admin/broadcast',{message})}
if(a!=='msg'&&a!=='bc')location.reload()});
</script></body></html>`);
}));

app.post('/admin/action', checkAdmin, wrap(async (req, res) => {
    const { reqId, action } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.json({ ok: false, message: 'Invalid action' });
    const r = await resolveWithdraw(reqId, action === 'approve');
    if (!r.ok) return res.json({ ok: false, message: r.message });
    res.json({ ok: true, message: `Request ${action}d!` });
}));

app.post('/admin/balance', checkAdmin, wrap(async (req, res) => {
    const { userId, action } = req.body;
    const amt = toMicro(req.body.amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1e9 * U) return res.json({ ok: false, message: 'Invalid amount' });

    let u;
    if (action === 'add') {
        u = await User.findOneAndUpdate({ id: String(userId) }, { $inc: { balance: amt } }, { new: true });
    } else {
        u = await User.findOneAndUpdate(
            { id: String(userId), balance: { $gte: amt } },
            { $inc: { balance: -amt } },
            { new: true }
        );
    }
    if (!u) return res.json({ ok: false, message: 'User not found or balance too low' });

    sendMsg(u.id, action === 'add'
        ? `🎁 Admin added +${fmtD(amt)} ${COIN} to your balance!`
        : `⚠️ Admin deducted ${fmtD(amt)} ${COIN} from your balance.`);
    res.json({ ok: true, message: `Done. New balance: ${fmtD(u.balance)} ${COIN}` });
}));

app.post('/admin/ban', checkAdmin, wrap(async (req, res) => {
    const ban = req.body.action === 'ban';
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { isBanned: ban }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    sendMsg(u.id, ban ? '🚫 <b>Account Banned</b> by admin.' : '✅ <b>Account Unbanned</b> by admin.');
    res.json({ ok: true, message: ban ? 'User banned' : 'User unbanned' });
}));

app.post('/admin/resetdevice', checkAdmin, wrap(async (req, res) => {
    const r = await Device.deleteMany({ userId: String(req.body.userId) });
    res.json({ ok: true, message: `Device lock reset (${r.deletedCount} device removed).` });
}));

app.post('/admin/resetwallet', checkAdmin, wrap(async (req, res) => {
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { $set: { wallet: null } }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    res.json({ ok: true, message: 'Wallet unlinked. User can link a new wallet on next withdraw.' });
}));

// Galat 'Multiple account' block hata do: is user par fingerprint/IP matching nahi lagegi (same deviceId wali check phir bhi chalti hai)
app.post('/admin/allowdevice', checkAdmin, wrap(async (req, res) => {
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { $set: { deviceOk: true } }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    res.json({ ok: true, message: 'Device allowed. User can open the app again.' });
}));

// Manual: verified user ka pending referral bonus referrer ko abhi de do
app.post('/admin/creditref', checkAdmin, wrap(async (req, res) => {
    const u = await User.findOne({ id: String(req.body.userId) });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    if (!u.referredBy) return res.json({ ok: false, message: 'This user has no referrer (Referred by = Direct). The /start link did not reach the bot.' });
    if (!u.isVerified) return res.json({ ok: false, message: 'User is not verified yet.' });
    const done = await creditReferral(u.id);
    res.json({ ok: done, message: done ? 'Referral credited and referrer notified.' : 'Nothing to credit: already in referrer list, or referrer not found in DB.' });
}));

// Sab verified referred users ke missed referrals ek saath theek karo (jo pehle se credited hain unhe dobara nahi milega)
app.post('/admin/repairrefs', checkAdmin, wrap(async (req, res) => {
    const users = await User.find({ isVerified: true, referredBy: { $ne: null } }, { id: 1 });
    let n = 0, failed = 0;
    for (const x of users) {
        try { if (await creditReferral(x.id)) n++; }
        catch (e) { failed++; console.log('Repair error for', x.id, e.message); }
    }
    res.json({ ok: true, message: `Repaired ${n} missed referral(s) out of ${users.length} referred users.` + (failed ? ` Failed: ${failed}` : '') });
}));

app.post('/admin/msg', checkAdmin, wrap(async (req, res) => {
    const u = await User.findOne({ id: String(req.body.userId) });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    await sendMsg(u.id, `📩 Message from Admin:\n\n${String(req.body.message).slice(0, 3000)}`, undefined, false);
    res.json({ ok: true, message: 'Message sent!' });
}));

app.post('/admin/broadcast', checkAdmin, wrap(async (req, res) => {
    const message = String(req.body.message || '').slice(0, 3500);
    if (!message.trim()) return res.json({ ok: false, message: 'Empty message' });
    const ids = (await User.find({ isBanned: false }, { id: 1 })).map(u => u.id);
    res.json({ ok: true, message: `Broadcast started for ${ids.length} users.` });
    for (const id of ids) {
        await sendMsg(id, message, undefined, false);
        await sleep(60);
    }
}));

// Unknown /api path: HTML ki jagah JSON 404
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// ---------- START ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(payoutReady() ? `💸 Auto payout: ${AUTO_PAYOUT ? 'ON' : 'OFF'} (max ${fmtD(MAX_AUTO_PAYOUT)} ${COIN})` : '💸 Auto payout: not configured (manual approve)');
    if (PUBLIC_URL.startsWith('https://')) {
        const r = await tg('setWebhook', {
            url: `${PUBLIC_URL}/api/webhook`,
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query']
        });
        console.log(r.ok ? '✅ Telegram webhook set' : '❌ Webhook failed', r.description || '');

        // KEEP-ALIVE: Render free server 15 min idle par so jata hai (cold start = 30-50s loading).
        // Har 10 minute me apne aap ko ping karte hain taake server jaagta rahe.
        setInterval(() => {
            fetch(PUBLIC_URL + '/health', { signal: AbortSignal.timeout(10000) }).catch(() => {});
        }, 10 * 60 * 1000).unref();
    } else {
        console.log('⚠️ PUBLIC_URL (https) not set - webhook not configured.');
    }
});
