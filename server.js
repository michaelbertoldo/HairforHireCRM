const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();
const supportDocs = require('./support_docs');

const app = express();
app.use(express.json({ verify: verifySignature }));

function verifySignature(req, res, buf) {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.ZENDESK_SHARED_SECRET)
    .update(buf)
    .digest('hex');

  const receivedSignature = req.header('X-Hub-Signature');
  if (expectedSignature !== receivedSignature) {
    throw new Error('Invalid webhook signature');
  }
}

function buildSystemPrompt(userMessage) {
  const docsFormatted = supportDocs.map(doc => `Q: ${doc.question}\nA: ${doc.answer}`).join('\n\n');
  return `
You are a helpful support agent for Hair for Hire, an app that helps users book stylists.

Customer said: "${userMessage}"

Use the knowledge base below to write a clear and professional response:

${docsFormatted}
  `.trim();
}

app.post('/webhook', async (req, res) => {
  const event = req.body;

  if (event.type !== 'conversation:message') return res.sendStatus(200);

  const userMessage = event.payload.message?.content?.text;
  const conversationId = event.payload.conversation.id;
  const appUserId = event.payload.message.author.userId;

  if (!userMessage || !conversationId) return res.sendStatus(400);

  const systemPrompt = buildSystemPrompt(userMessage);

  // Get AI reply
  const openaiRes = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  const aiReply = openaiRes.data.choices[0].message.content;

  // Send reply via Sunshine Conversations API
  await axios.post(
    `https://api.smooch.io/v1.1/apps/${process.env.ZENDESK_APP_ID}/conversations/${conversationId}/messages`,
    {
      role: 'appMaker',
      type: 'text',
      text: aiReply
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.ZENDESK_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
