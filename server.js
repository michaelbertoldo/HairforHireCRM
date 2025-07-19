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
    .digest('hex'); // This gives you a hex string

  const receivedHeader = req.header('X-Hub-Signature') || '';
  const receivedSignature = receivedHeader.replace(/^sha256=/, '');

  // Compare as hex strings, not UTF-8 buffers
  if (!crypto.timingSafeEqual(
    Buffer.from(receivedSignature, 'hex'),  // <- Changed from 'utf8' to 'hex'
    Buffer.from(expectedSignature, 'hex')   // <- Changed from 'utf8' to 'hex'
  )) {
    console.log('Signature verification failed:');
    console.log('Received:', receivedSignature);
    console.log('Expected:', expectedSignature);
    throw new Error('Invalid webhook signature');
  }
}

app.get('/', (req, res) => {
  res.send('Webhook server is running!');
});

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
  try {
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
      `https://api.smooch.io/v2/apps/${process.env.ZENDESK_APP_ID}/conversations/${conversationId}/messages`,
      {
        role: 'appMaker',
        type: 'text',
        text: aiReply
      },
      {
        auth: {
          username: process.env.ZENDESK_KEY_ID,
          password: process.env.ZENDESK_SECRET_KEY
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Internal server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));