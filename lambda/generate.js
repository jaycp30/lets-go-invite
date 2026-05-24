const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const crypto = require('crypto');
const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const MASCOT_SYSTEM =
  'You are a mischievous, playful, cute, and witty little mascot for a date invitation app. ' +
  'Your personality is like a cheeky kid — bubbly, teasing, a tiny bit dramatic, and charming. ' +
  'Keep every response very short (max 10 words). No heart or love emojis. Output only the text, no quotes.';

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method || '';
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const type = body.type || 'invite';

    if (type === 'reaction') {
      const reaction = await generateReaction();
      return respond(200, { reaction });
    }

    if (type === 'acceptInvite') {
      const result = await sendCalendarInvite(body);
      return respond(200, result);
    }

    // type === 'invite': run all generations in parallel
    const { name, activity, date, note } = body;
    if (!name || !activity || !date) {
      return respond(400, { error: 'name, activity, and date are required' });
    }

    const [[message, usedProvider], mascotIntro, buttonAnimCSS, confettiCSS] = await Promise.all([
      generateInviteMessage(name, activity, date, note),
      generateMascotIntro(name, activity),
      generateButtonAnimCSS(activity),
      generateConfettiCSS(activity),
    ]);

    return respond(200, {
      message,
      mascotIntro,
      buttonAnimCSS,
      confettiCSS,
      provider: usedProvider,
    });
  } catch (err) {
    console.error(err);
    return respond(500, { error: 'Something went wrong. Please try again.' });
  }
};

// ── Invite message ────────────────────────────────────────────────────────────

async function generateInviteMessage(name, activity, date, note) {
  const prompt = `Create a sweet, playful date invitation message (2-3 sentences) for:
- Recipient: ${name}
- Activity: ${activity}
- Date/time: ${date}
${note ? `- Personal note: ${note}` : ''}
Write only the invitation body — no greeting, no sign-off, no quotes. Warm, charming, ends with excitement. No heart or love emojis.`;

  try {
    const text = await generateWithOpenAI(prompt);
    return [text, 'openai'];
  } catch (err) {
    console.warn('OpenAI failed, falling back to Claude Haiku:', err.message);
    const text = await generateWithClaude(prompt);
    return [text, 'claude'];
  }
}

// ── Mascot intro line ─────────────────────────────────────────────────────────

async function generateMascotIntro(name, activity) {
  const prompt = `${name} just opened a date invitation for "${activity}". Give them a cheeky, flirty, playful greeting as their mascot. Max 10 words + 1 emoji.`;
  return generateMascotLine(prompt);
}

// ── No button reaction ────────────────────────────────────────────────────────

async function generateReaction() {
  const moods = [
    'surprised and giggling',
    'dramatically heartbroken',
    'smug and knowing',
    'playfully suspicious',
    'encouragingly persistent',
  ];
  const mood = moods[Math.floor(Math.random() * moods.length)];
  const prompt = `Someone tried to click "No" on a date invitation but the button escaped. React in a ${mood} way. Max 8 words + 1 emoji.`;
  return generateMascotLine(prompt);
}

// ── SES calendar invite on Yes ────────────────────────────────────────────────

async function sendCalendarInvite({ senderEmail, recipientName, activity, date, timezone, message }) {
  if (!senderEmail || !activity || !date) {
    return { ok: false, error: 'senderEmail, activity, and date are required' };
  }
  if (!isValidEmail(senderEmail)) {
    return { ok: false, error: 'senderEmail must be a valid email address' };
  }

  const fromEmail = process.env.SES_FROM_EMAIL;
  const sesRegion = process.env.SES_REGION || process.env.AWS_REGION || 'ap-northeast-1';
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL env var is not configured');
  }

  const tz = timezone || process.env.SES_CALENDAR_TIMEZONE || 'UTC';
  const startDateTime = normalizeLocalDateTime(date);
  const endDateTime = addHoursToLocalDateTime(startDateTime, 1);
  const safeRecipient = recipientName || 'Your guest';
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@jaycloud.net`;
  const summary = `${safeRecipient} said yes: ${activity}`;
  const description = [
    `${safeRecipient} accepted your invite.`,
    '',
    `Activity: ${activity}`,
    message ? `Invite message: ${message}` : '',
    '',
    'Sent by Unhinged Calendly.',
  ].filter(Boolean).join('\n');
  const ics = buildCalendarInvite({
    uid,
    summary,
    description,
    startDateTime,
    endDateTime,
    timezone: tz,
    organizerEmail: fromEmail,
    attendeeEmail: senderEmail,
  });

  const rawMessage = buildRawCalendarEmail({
    fromEmail,
    toEmail: senderEmail,
    subject: summary,
    text: `${safeRecipient} said yes to ${activity}.\n\nA calendar invite is attached.`,
    html: `<p><strong>${escapeHtml(safeRecipient)}</strong> said yes to <strong>${escapeHtml(activity)}</strong>.</p><p>A calendar invite is attached.</p>`,
    ics,
  });

  const result = await sendSesRawEmail({
    region: sesRegion,
    fromEmail,
    toEmail: senderEmail,
    rawMessage,
  });

  return { ok: true, messageId: result.SendRawEmailResponse?.SendRawEmailResult?.MessageId || result.messageId };
}

async function sendSesRawEmail({ region, fromEmail, toEmail, rawMessage }) {
  const params = new URLSearchParams({
    Action: 'SendRawEmail',
    Version: '2010-12-01',
    Source: fromEmail,
    'Destinations.member.1': toEmail,
    'RawMessage.Data': Buffer.from(rawMessage, 'utf8').toString('base64'),
  });
  const body = params.toString();
  const host = `email.${region}.amazonaws.com`;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials are not available to sign SES request');
  }
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/ses/aws4_request`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    Host: host,
    'X-Amz-Date': amzDate,
  };
  if (process.env.AWS_SESSION_TOKEN) {
    headers['X-Amz-Security-Token'] = process.env.AWS_SESSION_TOKEN;
  }

  const signedHeaderNames = Object.keys(headers).map(key => key.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames
    .map(key => `${key}:${headers[Object.keys(headers).find(original => original.toLowerCase() === key)].trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(body, 'hex'),
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest, 'hex'),
  ].join('\n');
  const signingKey = getSignatureKey(process.env.AWS_SECRET_ACCESS_KEY, dateStamp, region, 'ses');
  const signature = hmac(signingKey, stringToSign, 'hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await httpsRequest({
    hostname: host,
    path: '/',
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`SES HTTP ${response.statusCode}: ${response.body}`);
  }

  return { messageId: extractXmlValue(response.body, 'MessageId') };
}

function buildRawCalendarEmail({ fromEmail, toEmail, subject, text, html, ics }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const encodedSubject = encodeMimeHeader(subject);
  const encodedText = wrapBase64(Buffer.from(text, 'utf8').toString('base64'));
  const encodedHtml = wrapBase64(Buffer.from(html, 'utf8').toString('base64'));
  const encodedIcs = wrapBase64(Buffer.from(ics, 'utf8').toString('base64'));

  return [
    `From: "Unhinged Calendly" <${fromEmail}>`,
    `To: ${toEmail}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedHtml,
    '',
    `--${boundary}`,
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST; name="invite.ics"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Class: urn:content-classes:calendarmessage',
    '',
    encodedIcs,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

function buildCalendarInvite({ uid, summary, description, startDateTime, endDateTime, timezone, organizerEmail, attendeeEmail }) {
  const now = formatIcsUtc(new Date());
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Unhinged Calendly//Invite//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(uid)}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=${escapeIcs(timezone)}:${formatIcsLocal(startDateTime)}`,
    `DTEND;TZID=${escapeIcs(timezone)}:${formatIcsLocal(endDateTime)}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `ORGANIZER;CN=Unhinged Calendly:mailto:${organizerEmail}`,
    `ATTENDEE;CN=You;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeLocalDateTime(value) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value.slice(0, 16);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid invite date');
  return date.toISOString().slice(0, 16);
}

function addHoursToLocalDateTime(value, hours) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) throw new Error('Invalid local date');
  const [, y, mo, d, h, mi] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h + hours, mi));
  return date.toISOString().slice(0, 16);
}

function formatIcsLocal(value) {
  return value.replace(/[-:]/g, '');
}

function formatIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcs(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') || value;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sha256(value, encoding) {
  return crypto.createHash('sha256').update(value, 'utf8').digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function extractXmlValue(xml, tagName) {
  return xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`))?.[1] || null;
}

// ── No button CSS escape animation ───────────────────────────────────────────

async function generateButtonAnimCSS(activity) {
  const prompt = `Write a CSS @keyframes block named "noEscape" for a button that playfully dodges clicks, themed for "${activity}".
- Use only transform properties (translate, rotate, scale)
- 4-5 keyframe stops
- Lively and fun, matches the activity energy
- STRICT 220 character limit
- Return ONLY the @keyframes block, nothing else`;

  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  });
  return stripFences(res.content[0].text.trim());
}

// ── Confetti celebration CSS ──────────────────────────────────────────────────

async function generateConfettiCSS(activity) {
  const prompt = `Write a CSS @keyframes block named "confettiFall" for celebration confetti, themed for "${activity}".
- Animate: translateY from -20px to 110vh, rotation, slight horizontal sway
- End with opacity: 0
- STRICT 220 character limit
- Return ONLY the @keyframes block, nothing else`;

  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  });
  return stripFences(res.content[0].text.trim());
}

// ── AI helpers ────────────────────────────────────────────────────────────────

async function generateMascotLine(prompt) {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    system: MASCOT_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

async function generateWithClaude(prompt) {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

async function generateWithOpenAI(prompt) {
  const client = new OpenAI();
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content.trim();
}

function stripFences(text) {
  return text.replace(/^```[\w]*\n?/m, '').replace(/```\s*$/m, '').trim();
}

function sanitizeSvg(svg) {
  return stripFences(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
