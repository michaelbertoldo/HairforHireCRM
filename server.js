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

  const receivedHeader = req.header('X-Hub-Signature') || '';
  const receivedSignature = receivedHeader.replace(/^sha256=/, '');

  if (!crypto.timingSafeEqual(
    Buffer.from(receivedSignature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
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
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    const event = req.body;
    if (event.type !== 'conversation:message') return res.sendStatus(200);

    const userMessage = event.payload.message?.content?.text;
    const conversationId = event.payload.conversation.id;

    console.log('Extracted data:', { userMessage, conversationId });

    if (!userMessage || !conversationId) return res.sendStatus(400);

    const systemPrompt = buildSystemPrompt(userMessage);
    console.log('Built system prompt');

    // Get AI reply from OpenAI
    console.log('Calling OpenAI...');
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
    console.log('✅ AI Reply generated:', aiReply);
    
    // Skip Sunshine API call for now - just log what we would send
    console.log('Would send to conversation:', conversationId);
    console.log('✅ Webhook test successful!');
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    console.error('Full error:', error.response?.data || error);
    res.status(500).send('Internal server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));