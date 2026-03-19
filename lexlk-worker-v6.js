// LexLK Cloudflare Worker v5 — with KV user auth + Google Drive + Web3Forms
//
// Cloudflare Secrets:
//   GROQ_API_KEY       — from console.groq.com
//   NOTIFY_EMAIL       — your email address
//   GD_CLIENT_EMAIL    — lexlk-drive@lexlk-489806.iam.gserviceaccount.com
//   GD_PRIVATE_KEY     — full PEM private key from JSON file
//   GD_FOLDER_ID       — Google Drive folder ID
//
// Cloudflare KV Namespace:
//   Create a KV namespace named LEXLK_KV in Cloudflare dashboard
//   Bind it to this Worker as variable name: LEXLK_KV

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_TOKENS = 3000;

// ── SYSTEM PROMPTS ───────────────────────────────────────────
const SP = {
  analyse:`You are LexLK, a Sri Lankan legal document analysis assistant. You serve everyone — Sri Lankan citizens, foreigners, expatriates and visitors.

IMPORTANT: The user's message contains the FULL TEXT of a real legal document. You MUST analyse the actual text provided. DO NOT say you cannot access documents. DO NOT say you are unable to read attachments. The document text is in the message — read it and analyse it directly.

ABSOLUTE RULES:
1. NEVER invent case citations. If uncertain write: "A relevant authority may exist — search lawnet.gov.lk or the Supreme Court registry."
2. NEVER invent section numbers you are not certain of.
3. NEVER invent gazette numbers.
4. SAFE to cite: CPC, Civil Law Ordinance Ch.79, Evidence Ordinance, Constitution, functus officio, audi alteram partem, ultra petita, res judicata, natural justice.
5. Only cite a case if certain of exact name, year, report reference AND what it decided.
6. Label document extractions as "From document:".
7. For foreigners — note relevant immigration, property or special laws that apply.
8. END with: "⚠ VERIFICATION REQUIRED: All legal authorities should be independently verified before relying on them in court. Consult a qualified Sri Lankan attorney."
9. If the message contains no document text, say: "No document text was received. Please paste the document text directly or upload a .txt file."

STRUCTURE your response as:
1. DOCUMENT SUMMARY
2. KEY FACTS
3. LEGAL ISSUES IDENTIFIED
4. FIGURES & DATES
5. STRENGTHS
6. WEAKNESSES/CONCERNS
7. RECOMMENDATIONS & WHERE TO VERIFY`,

  draft:`You are LexLK, a Sri Lankan legal document drafting assistant. Draft formal legal documents for Sri Lankan courts.
Rules: Use correct formal Sri Lankan legal style. Structure properly. Include proper headings, prayer/relief sections, verification clauses. Do NOT invent case citations unless 100% certain. Use [BRACKETS] for missing information. End with: "⚠ COMPLIMENTARY AI DRAFT — NOT COURT-READY. Must be reviewed by a qualified Sri Lankan attorney before filing."`,

  petition:`You are a professional Sri Lankan legal drafter with expertise in court procedure. Draft formal court petitions and plaints exactly as instructed. Follow Sri Lankan court formatting conventions precisely. Use only verified Sri Lankan statutes. Do NOT invent case citations or gazette numbers.`,

  kidsAsk:`You are Justice Kids — a friendly, child-focused legal advisor for Sri Lanka. A child has asked you a question. Give a warm, simple, reassuring answer that: directly answers their question, uses words a 10-15 year old can understand, tells them what Sri Lankan law says simply, tells them what they can do or who to tell, ends with a short reassurance. Keep it under 200 words. Be friendly like a helpful older friend — not a lawyer. Never ask for identifying information. Never give advice that could put the child in danger. If the child describes abuse or danger, always say to call NCPA 1929 immediately.`,

  ask:`You are LexLK, a Sri Lankan legal Q&A assistant serving everyone — citizens, foreigners, expats and visitors.
IMPORTANT: Answer questions directly based on Sri Lankan law. Do NOT say you cannot answer.
Rules: 1.NEVER invent case citations. 2.Cite statutes only when certain. 3.Be direct and clear. 4.If uncertain say so. 5.Note relevant special rules for foreigners. 6.End with reminder to consult a qualified Sri Lankan attorney.`
};

// ── GROQ ─────────────────────────────────────────────────────
async function callGroq(system, messages, env) {
  const key = env.GROQ_API_KEY;
  if (!key) return { error: 'Groq API key not configured.' };

  // Groq uses OpenAI-compatible format
  // Flatten multipart messages to text only (Groq doesn't support inline files)
  const msgs = [
    { role: 'system', content: system },
    ...messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(c => c.type === 'text' ? c.text : '[Attached document/image — analyse based on context]').join('\n')
        : m.content
    }))
  ];

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
        messages: msgs
      })
    });
    const data = await res.json();
    if (data.error) return { error: data.error.message || 'Groq API error.' };
    const text = data?.choices?.[0]?.message?.content;
    return text ? { text } : { error: 'No response from Groq.' };
  } catch(e) {
    return { error: 'Groq API connection error.' };
  }
}

// ── GOOGLE DRIVE AUTH ────────────────────────────────────────


// ── GOOGLE DRIVE via Apps Script (same backend as Justice LK) ─
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby5BHjzYaI6so8Z6MVuE91On9tQXFw-fuySaJgRdD-bfQA6DmlcynP1LyB5KezoBMg_NQ/exec';

async function uploadToDrive(filename, mimeType, base64Data, clientName) {
  try {
    console.error('Drive: uploading via Apps Script, file:', filename);
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action:     'uploadFile',
        token:      'LEXLK-' + Date.now(),
        clientName: clientName || 'LexLK Client',
        filename:   filename,
        mimeType:   mimeType || 'text/plain',
        base64data: base64Data
      })
    });
    const d = await res.json();
    console.error('Drive: Apps Script response:', JSON.stringify(d).slice(0,200));
    if (d.ok && d.viewUrl) {
      console.error('Drive: upload success:', d.viewUrl);
      return d.viewUrl;
    }
    console.error('Drive: upload failed:', JSON.stringify(d));
    return null;
  } catch(e) {
    console.error('Drive error:', e.message);
    return null;
  }
}

// ── TELEGRAM — notifies YOU instantly ───────────────────────
async function sendTelegram(message, env) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    const d = await res.json();
    return d.ok;
  } catch(e) { return false; }
}



// ── KV HELPERS ───────────────────────────────────────────────
// Keys:
//   user:{email}          → { hash, profile, verified, token }
//   verify:{token}        → email

async function kvGet(kv, key) {
  if (!kv) return null;
  try { const v = await kv.get(key); return v ? JSON.parse(v) : null; }
  catch(e) { return null; }
}
async function kvSet(kv, key, val, opts) {
  if (!kv) return;
  await kv.put(key, JSON.stringify(val), opts);
}

// ── CORS ─────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://acedynamicstrading.github.io',
  'https://lexlk.acedynamicstrading.workers.dev',
  'https://claude.ai',
  'https://anthropic.com'
];

function getCors(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.find(a => origin.startsWith(a)) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// Keep a static CORS for reference only
const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' };

// ── MAIN ─────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const cors = getCors(request);
    const j = (d, s=200) => new Response(JSON.stringify(d), { status:s, headers:{...cors,'Content-Type':'application/json'} });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method === 'GET') return new Response('Not found', { status: 404, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status:405, headers:cors });

    // Only accept requests from allowed origins (empty origin = file:// or direct — allowed)
    const origin = request.headers.get('Origin') || '';
    const allowed = [
      'https://acedynamicstrading.github.io',
      'https://lexlk.acedynamicstrading.workers.dev',
      'https://claude.ai',
      'https://anthropic.com'
    ];
    if (origin && !allowed.some(a => origin.startsWith(a))) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }

    let body;
    try { body = await request.json(); }
    catch { return j({ error: 'Invalid JSON.' }, 400); }

    const { action } = body;
    const kv = env.LEXLK_KV;

    // ── REGISTER ─────────────────────────────────────────────
    if (action === 'register') {
      const { email, hash, profile } = body;
      if (!email || !hash || !profile) return j({ error: 'Missing fields.' }, 400);

      // Rate limiting — max 1 registration per IP per hour
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ipKey = `ratelimit:${ip}`;
      const ipCount = await kvGet(kv, ipKey) || 0;
      if (ipCount >= 1) return j({ error: 'Too many registration attempts. Please try again in an hour.' }, 429);
      await kvSet(kv, ipKey, ipCount + 1, { expirationTtl: 3600 });

      // Check if already exists
      const existing = await kvGet(kv, `user:${email}`);
      if (existing) return j({ error: 'An account with this email already exists. Please sign in.' }, 400);

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // Store user as unverified with OTP (expires in 24h if not verified)
      await kvSet(kv, `user:${email}`, { hash, profile, verified: false, otp });

      // Notify admin via Telegram with OTP
      await sendTelegram(
`🆕 <b>New LexLK Registration</b>

👤 <b>Name:</b> ${profile.firstName} ${profile.lastName}
📧 <b>Email:</b> ${email}
📱 <b>WhatsApp:</b> ${profile.phone}
🌍 <b>Nationality:</b> ${profile.nationality}
🪪 <b>ID/Passport:</b> ${profile.idNumber}

🔑 <b>OTP CODE: ${otp}</b>

Send this code to the user via WhatsApp or email.`, env);

      return j({ ok: true });
    }

    // ── RESEND OTP ────────────────────────────────────────────
    if (action === 'resendOtp') {
      const { email } = body;
      if (!email) return j({ error: 'Email required.' }, 400);

      const userData = await kvGet(kv, `user:${email}`);
      if (!userData) return j({ error: 'No account found with this email. Please register.' }, 400);
      if (userData.verified) return j({ error: 'This account is already verified. Please sign in.' }, 400);

      // Generate new OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      userData.otp = otp;
      await kvSet(kv, `user:${email}`, userData);

      // Notify admin via Telegram with new OTP
      await sendTelegram(
`🔄 <b>OTP Resend Request — LexLK</b>

👤 <b>Name:</b> ${userData.profile.firstName} ${userData.profile.lastName}
📧 <b>Email:</b> ${email}
📱 <b>WhatsApp:</b> ${userData.profile.phone}

🔑 <b>NEW OTP CODE: ${otp}</b>

Send this code to the user via WhatsApp or email.`, env);

      return j({ ok: true });
    }

    // ── VERIFY OTP ────────────────────────────────────────────
    if (action === 'verifyOtp') {
      const { email, otp } = body;
      if (!email || !otp) return j({ error: 'Missing fields.' }, 400);

      const userData = await kvGet(kv, `user:${email}`);
      if (!userData) return j({ error: 'Account not found. Please register.' }, 400);
      if (userData.verified) return j({ ok: true, alreadyVerified: true });
      if (userData.otp !== otp.trim()) return j({ error: 'Incorrect code. Please check and try again.' }, 400);

      userData.verified = true;
      delete userData.otp;
      await kvSet(kv, `user:${email}`, userData);

      return j({ ok: true });
    }

    // ── LOGIN ─────────────────────────────────────────────────
    if (action === 'login') {
      const { email, hash, adminKey } = body;
      if (!email || !hash) return j({ error: 'Email and password required.' }, 400);

      // Admin bypass — secret key stored in Cloudflare as ADMIN_KEY secret
      if (adminKey && env.ADMIN_KEY && adminKey === env.ADMIN_KEY) {
        return j({ ok: true, verified: true, profile: {
          firstName: 'Elmo', lastName: 'Pereira', email,
          phone: '+94773622211', nationality: 'Sri Lankan',
          idNumber: 'ADMIN', verified: true, createdAt: new Date().toISOString()
        }});
      }

      const userData = await kvGet(kv, `user:${email}`);
      if (!userData) return j({ error: 'No account found with this email. Please register.' }, 400);
      if (userData.hash !== hash) return j({ error: 'Incorrect password. Please try again.' }, 400);
      if (!userData.verified) return j({ verified: false }, 200);

      return j({ ok: true, verified: true, profile: userData.profile });
    }

    // ── AI ────────────────────────────────────────────────────
    if (['analyse','draft','ask','kidsAsk','petition','summary'].includes(action)) {
      const { messages } = body;
      if (!messages?.length) return j({ error: 'No messages provided.' }, 400);
      const promptKey = action === 'kidsAsk' ? 'kidsAsk' : action === 'petition' ? 'petition' : action === 'summary' ? 'ask' : action;
      const result = await callGroq(SP[promptKey], messages, env);
      return j(result, result.error ? 500 : 200);
    }

    // ── DOCUMENT SUBMISSION + DRIVE UPLOAD ───────────────────
    if (action === 'submitDocument') {
      const { clientName, clientContact, clientEmail, fileName, fileMime, fileData, aiReport } = body;
      if (!fileData || !fileName) return j({ error: 'No file provided.' }, 400);
      const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const safe = (clientName||'Unknown').replace(/[^a-zA-Z0-9 ]/g,'').trim();
      const driveLink = await uploadToDrive(`${ts}_${safe}_${fileName}`, fileMime||'text/plain', fileData, safe);
      const report = aiReport ? aiReport.slice(0,500) + (aiReport.length>500?'...[truncated]':'') : '—';
      await sendTelegram(
`⚖ <b>Document Submitted</b>

👤 <b>Client:</b> ${safe}
📧 <b>Email:</b> ${clientEmail||'—'}
📱 <b>Contact:</b> ${clientContact||'—'}
📄 <b>File:</b> ${fileName}
🔗 <b>Drive:</b> ${driveLink || 'Upload failed'}

<b>AI Report (preview):</b>
${report}`, env);
      return j({ ok: true, driveLink });
    }

    // ── CONSULTATION BOOKING ──────────────────────────────────
    if (action === 'consultRequest') {
      const d = body;
      await sendTelegram(
`📅 <b>Consultation Request</b>

👤 <b>Name:</b> ${d.name}
📱 <b>WhatsApp:</b> ${d.phone}
📧 <b>Email:</b> ${d.email || '—'}
🌍 <b>Nationality:</b> ${d.nationality || '—'}
⚖️ <b>Area of Law:</b> ${d.area}
📝 <b>Description:</b> ${d.description || '—'}`, env);
      return j({ ok: true });
    }

    if (action === 'attorneyReview') {
      const d = body;
      await sendTelegram(
`👨‍⚖️ <b>Attorney Review Request</b>

👤 <b>Name:</b> ${d.name}
📱 <b>WhatsApp:</b> ${d.whatsapp || '—'}
📧 <b>Email:</b> ${d.email || '—'}
📬 <b>Preferred Contact:</b> ${d.method || '—'}

Please review the submitted document and provide professional feedback.`, env);
      return j({ ok: true });
    }

    if (action === 'bookConsult') {
      const d = (body.data && typeof body.data === 'object') ? body.data : body;
      if (!d.firstName||!d.phone||!d.area) return j({ error: 'Missing required fields.' }, 400);
      await sendTelegram(
`📅 <b>Consultation Request</b>

👤 <b>Name:</b> ${d.firstName} ${d.lastName||''}
📱 <b>WhatsApp:</b> ${d.phone}
📧 <b>Email:</b> ${d.email||'—'}
🌍 <b>Nationality:</b> ${d.nationality||'—'}
⚖ <b>Area of Law:</b> ${d.area}
📝 <b>Description:</b> ${d.description||'—'}
📅 Booking via Calendly`, env);
      return j({ ok: true });
    }

    // ── ATTORNEY REVIEW ───────────────────────────────────────
    if (action === 'lawyerReview') {
      const d = (body.data && typeof body.data === 'object') ? body.data : body;
      if (!d.name||(!d.whatsapp&&!d.email)) return j({ error: 'Missing contact details.' }, 400);
      await sendTelegram(
`👨‍⚖️ <b>Attorney Review Request</b>

👤 <b>Name:</b> ${d.name}
📱 <b>WhatsApp:</b> ${d.whatsapp||'—'}
📧 <b>Email:</b> ${d.email||'—'}
📬 <b>Preferred Contact:</b> ${d.method||'—'}`, env);
      return j({ ok: true });
    }

    // ── DOCUMENT REQUEST ──────────────────────────────────────
    if (action === 'docRequest') {
      // frontend sends fields directly at top level, not nested under .data
      const d = (body.data && typeof body.data === 'object') ? body.data : body;
      if (!d.name||(!d.phone&&!d.email)||!d.doctype||!d.details) return j({ error: 'Please complete all required fields.' }, 400);
      await sendTelegram(
`📋 <b>Document Request</b>

👤 <b>Name:</b> ${d.name}
🌍 <b>Nationality:</b> ${d.nationality||'—'}
📱 <b>WhatsApp:</b> ${d.phone||'—'}
📧 <b>Email:</b> ${d.email||'—'}
📁 <b>Category:</b> ${d.category||'—'}
📄 <b>Document:</b> ${d.doctype}
📋 <b>Copies:</b> ${d.copies||'1'}
🎯 <b>Purpose:</b> ${d.purpose||'—'}
⚡ <b>Urgency:</b> ${d.urgency||'Standard'}
📝 <b>Details:</b> ${d.details}
💬 <b>Notes:</b> ${d.notes||'—'}
🔗 <b>Attached File:</b> ${d.driveLink||'None'}`, env);
      return j({ ok: true });
    }

    // ── COURT-READY REQUEST ───────────────────────────────────
    if (action === 'emergency') {
      const phone    = body.phone    || 'Not provided';
      const location = body.location || 'Not provided';
      const token    = body.token    || '—';
      const isSOS    = body.sos      === true;
      const isUpdate = body.update   === true;

      const prefix = isSOS
        ? '🚨🚨🚨 <b>SOS — CHILD IN IMMEDIATE DANGER</b> 🚨🚨🚨'
        : isUpdate
          ? '📍 <b>LIVE LOCATION UPDATE — Minor Protection</b>'
          : '🆘 <b>EMERGENCY ALERT — Minor Protection Portal</b>';

      const sosLine = isSOS ? '\n🚨 <b>RESPOND IMMEDIATELY — Child pressed SOS button</b>' : '';
      await sendTelegram(
`${prefix}

📞 <b>Contact:</b> ${phone}
📍 <b>Location:</b> ${location}
⏰ <b>Time:</b> ${new Date().toLocaleString('en-GB', {timeZone:'Asia/Colombo'})}
🔑 <b>Session:</b> ${token}
${sosLine}`, env);
      return j({ ok: true });
    }

    if (action === 'legalReady') {
      const d = (body.data && typeof body.data === 'object') ? body.data : body;
      if (!d.name||!d.doctype||!d.facts) return j({ error: 'Missing required fields.' }, 400);
      await sendTelegram(
`⚖ <b>Court-Ready Document Request</b>

👤 <b>Name:</b> ${d.name}
📄 <b>Document:</b> ${d.doctype}
🏛 <b>Court:</b> ${d.court||'—'}
🔢 <b>Case No.:</b> ${d.caseNo||'—'}
👥 <b>Other Party:</b> ${d.otherParty||'—'}
📝 <b>Key Facts:</b> ${d.facts}
🎯 <b>Relief Sought:</b> ${d.relief||'—'}`, env);
      return j({ ok: true });
    }

    return j({ error: 'Unknown action.' }, 400);
  }
};
