const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();
const supportDocs = require('./support_docs');

const app = express();
app.use(express.json({ verify: verifySignature }));

function verifySignature(req, res, buf) {
  const receivedHeader = req.header('X-Hub-Signature') || '';
  
  // Skip verification if no signature provided (for testing)
  if (!receivedHeader) {
    console.log('⚠️ No signature provided - skipping verification');
    return;
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.ZENDESK_SHARED_SECRET)
    .update(buf)
    .digest('hex');

  const receivedSignature = receivedHeader.replace(/^sha256=/, '');

  // Ensure both signatures are valid hex strings and same length
  if (!receivedSignature || !expectedSignature || 
      receivedSignature.length !== expectedSignature.length) {
    console.log('Signature format error:');
    console.log('Received length:', receivedSignature?.length);
    console.log('Expected length:', expectedSignature?.length);
    throw new Error('Invalid webhook signature format');
  }

  if (!crypto.timingSafeEqual(
    Buffer.from(receivedSignature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  )) {
    console.log('Signature verification failed:');
    console.log('Received:', receivedSignature);
    console.log('Expected:', expectedSignature);
    throw new Error('Invalid webhook signature');
  }
  
  console.log('✅ Signature verified successfully');
}

app.get('/', (req, res) => {
  res.send('AI Chatbot server is running!');
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
    console.log('🔔 Webhook received:', JSON.stringify(req.body, null, 2));
    
    const event = req.body;
    
    // Only process conversation messages
    if (event.type !== 'conversation:message') {
      console.log('⏭️ Skipping non-message event:', event.type);
      return res.sendStatus(200);
    }

    // CRITICAL: Skip messages from the bot itself to prevent loops
    if (event.payload.message.author.type === 'appMaker') {
      console.log('🤖 Skipping bot message to prevent loop');
      return res.sendStatus(200);
    }

    const userMessage = event.payload.message?.content?.text;
    const conversationId = event.payload.conversation.id;
    const userId = event.payload.message.author.userId;

    console.log('📝 Extracted data:', { userMessage, conversationId, userId });

    if (!userMessage || !conversationId) {
      console.log('❌ Missing required data');
      return res.sendStatus(400);
    }

    // Build system prompt with support docs
    const systemPrompt = buildSystemPrompt(userMessage);
    console.log('📋 Built system prompt');

    // Get AI response from OpenAI
    console.log('🧠 Calling OpenAI...');
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiReply = openaiRes.data.choices[0].message.content;
    console.log('✅ AI Reply generated:', aiReply);

    // Send reply via Sunshine Conversations API
    console.log('📤 Sending reply to Sunshine...');
    await axios.post(
      `https://api.smooch.io/v1.1/apps/${process.env.ZENDESK_APP_ID}/conversations/${conversationId}/messages`,
      {
        author: {
          type: 'appMaker',
          displayName: 'Hair for Hire Support'
        },
        content: {
          type: 'text',
          text: aiReply
        }
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

    console.log('🎉 SUCCESS: AI response sent to user!');
    res.sendStatus(200);
    
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    console.error('📋 Error details:', error.response?.data || error);
    res.status(500).send('Internal server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 AI Chatbot server running on port ${PORT}`));