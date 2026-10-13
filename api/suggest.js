// Vercel serverless function: suggests which knowledge-base topics fit a customer chat.
// Put this file at api/suggest.js and topics.json at the repo root (next to index.html).
// Environment variables (Vercel > Settings > Environment Variables):
//   ANTHROPIC_API_KEY  your Claude API key
//   KB_SHARED_KEY      any long random text; the same text goes in the extension Settings
const topics = require('../topics.json');
const MODEL = 'claude-haiku-4-5-20251001';

const redact = (t) => String(t || '')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]');

const SYSTEM = `You help customer support agents at a scooter-sharing company find the right knowledge-base topic for the conversation they are handling.
You receive the text of a chat (it may include agent replies and interface text) and a list of knowledge-base topics.
Pick up to 3 topics that best fit the customer's current problem, best first. If nothing fits, return an empty list.
Answer with JSON only, no other text: {"suggestions":[{"id":"<topic id>","reason":"<six words or fewer>"}]}`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-kb-key');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!process.env.KB_SHARED_KEY || req.headers['x-kb-key'] !== process.env.KB_SHARED_KEY) {
    return res.status(401).json({ error: 'Wrong or missing key' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const text = redact((body && body.text) || '').trim().slice(-3500);
  if (text.length < 10) return res.status(400).json({ error: 'No chat text' });

  const list = topics.map((t) => `${t.id} | ${t.title} | ${t.bucket} | ${t.hint}`).join('\n');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Topics (id | title | bucket | start of content):\n${list}\n\nChat:\n${text}` }],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: `AI service answered ${r.status}` });
    const data = await r.json();
    const raw = (data.content || []).map((c) => c.text || '').join('');
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { suggestions: [] };
    const byId = new Map(topics.map((t) => [t.id, t]));
    const suggestions = (parsed.suggestions || [])
      .filter((s) => s && byId.has(s.id))
      .slice(0, 3)
      .map((s) => ({ id: s.id, title: byId.get(s.id).title, bucket: byId.get(s.id).bucket, reason: String(s.reason || '').slice(0, 80) }));
    return res.status(200).json({ suggestions });
  } catch (e) {
    return res.status(500).json({ error: 'Could not get a suggestion' });
  }
};
