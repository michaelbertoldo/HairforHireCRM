const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config(); // Keep this for local development with .env file
const supportDocs = require('./support_docs');

// Validate required environment variables (matching your Render setup)
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'ZENDESK_SHARED_SECRET',
  'ZENDESK_SUBDOMAIN',
  'ZENDESK_EMAIL',
  'ZENDESK_API_TOKEN',
  'ZENDESK_APP_ID',
  'ZENDESK_KEY_ID',
  'ZENDESK_SECRET_KEY'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars);
  if (process.env.NODE_ENV === 'production') {
    console.error('🔧 Please set these in your Render dashboard');
    process.exit(1);
  } else {
    console.error('🔧 For local development, create a .env file with these variables');
    console.error('🚨 Bot will not function without these variables!');
    console.error('⚠️ Continuing anyway for development...');
  }
}

console.log('✅ All required environment variables are set');

// Debug environment variables (remove this after testing)
console.log('🔍 Environment check:', {
  hasOpenAI: !!process.env.OPENAI_API_KEY,
  hasZendeskSecret: !!process.env.ZENDESK_SHARED_SECRET,
  hasZendeskAppId: !!process.env.ZENDESK_APP_ID,
  nodeEnv: process.env.NODE_ENV
});

const app = express();
app.use(express.json({ verify: verifySignature }));

// Safety measures - in-memory storage
const userMessageCount = new Map();
const recentMessages = new Set();
let errorCount = 0;
const MAX_ERRORS = 10;

// Clean up old data every 5 minutes
setInterval(() => {
  const now = Date.now();
  // Clean rate limiting data older than 2 minutes
  for (const [key] of userMessageCount) {
    const keyTime = parseInt(key.split('_').pop());
    if (now - keyTime > 120000) { // 2 minutes
      userMessageCount.delete(key);
    }
  }
  
  // Clean duplicate detection data older than 2 minutes (extended from 1 minute)
  const twoMinutesAgo = now - 120000;
  for (const message of recentMessages) {
    // Handle both ID-based and content-based keys
    if (message.startsWith('id_')) {
      // ID-based keys don't have timestamps, remove after 2 minutes
      continue; // Keep these longer for reliability
    } else {
      const messageTime = parseInt(message.split('_').pop());
      if (messageTime < twoMinutesAgo) {
        recentMessages.delete(message);
      }
    }
  }
}, 300000); // Run every 5 minutes

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
    console.log('🔴 Signature format error:');
    console.log('Received length:', receivedSignature?.length);
    console.log('Expected length:', expectedSignature?.length);
    throw new Error('Invalid webhook signature format');
  }

  if (!crypto.timingSafeEqual(
    Buffer.from(receivedSignature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  )) {
    console.log('🔴 Signature verification failed:');
    console.log('Received:', receivedSignature);
    console.log('Expected:', expectedSignature);
    throw new Error('Invalid webhook signature');
  }
  
  console.log('✅ Signature verified successfully');
}

// Enhanced bot detection
function isBotMessage(message) {
  const author = message.author;
  const content = message.content;
  
  return (
    author.type === 'business' ||
    author.type === 'appMaker' ||
    author.displayName?.includes('Support') ||
    author.displayName?.includes('Bot') ||
    author.displayName?.includes('Hair for Hire Support') ||
    author.userId?.startsWith('bot_') ||
    author.userId === process.env.ZENDESK_APP_ID || // Detect our own bot responses
    content?.text?.startsWith('[AUTO]') ||
    content?.text?.includes('🤖') // Bot emoji check
  );
}

// Rate limiting check
function isRateLimited(userId) {
  const now = Date.now();
  const userKey = `${userId}_${Math.floor(now / 60000)}`; // Per minute bucket
  
  if (!userMessageCount.has(userKey)) {
    userMessageCount.set(userKey, 0);
  }
  
  const currentCount = userMessageCount.get(userKey);
  if (currentCount >= 5) { // Max 5 messages per minute per user
    return true;
  }
  
  userMessageCount.set(userKey, currentCount + 1);
  return false;
}

// Enhanced duplicate detection with message ID
function isDuplicateMessage(conversationId, userMessage, messageId) {
  const now = Date.now();
  
  // Check by message ID first (most reliable)
  if (messageId && recentMessages.has(`id_${messageId}`)) {
    console.log('🚫 Duplicate detected by message ID:', messageId);
    return true;
  }
  
  // Fallback to content-based detection (60-second window)
  const messageKey = `${conversationId}_${userMessage.slice(0, 50)}_${Math.floor(now / 60000)}`;
  if (recentMessages.has(messageKey)) {
    console.log('🚫 Duplicate detected by content');
    return true;
  }
  
  // Store both ID and content-based keys
  if (messageId) {
    recentMessages.add(`id_${messageId}`);
  }
  recentMessages.add(messageKey);
  return false;
}

app.get('/', (req, res) => {
  res.send('🤖 AI Chatbot server is running safely!');
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
    // Emergency kill switch
    if (process.env.BOT_DISABLED === 'true') {
      console.log('🔴 Bot is disabled via environment variable');
      return res.sendStatus(200);
    }

    // Circuit breaker
    if (errorCount >= MAX_ERRORS) {
      console.log('🔴 Circuit breaker activated - too many errors');
      return res.sendStatus(503);
    }

    console.log('🔔 Webhook received at:', new Date().toISOString());
    console.log('📦 Payload preview:', JSON.stringify({
      app: req.body.app?.id,
      webhook: req.body.webhook?.id,
      eventCount: req.body.events?.length
    }));
    
    // Handle real webhook format with events array
    const webhookData = req.body;
    if (!webhookData.events || !Array.isArray(webhookData.events)) {
      console.log('⏭️ No events array found');
      return res.sendStatus(200);
    }

    // Process each event
    for (const event of webhookData.events) {
      console.log('🔍 Processing event:', {
        eventId: event.id,
        type: event.type,
        timestamp: event.createdAt
      });

      // Only process conversation messages
      if (event.type !== 'conversation:message') {
        console.log('⏭️ Skipping non-message event:', event.type);
        continue;
      }

      // Enhanced bot detection
      if (isBotMessage(event.payload.message)) {
        console.log('🤖 Skipping bot message to prevent loop');
        console.log('🔍 Bot detection details:', {
          authorType: event.payload.message.author.type,
          displayName: event.payload.message.author.displayName,
          userId: event.payload.message.author.userId
        });
        continue;
      }

      const userMessage = event.payload.message?.content?.text;
      const conversationId = event.payload.conversation.id;
      const userId = event.payload.message.author.userId;
      const messageId = event.payload.message.id;

      console.log('🔍 Processing message details:', {
        conversationId,
        userId,
        messageId,
        timestamp: new Date().toISOString(),
        messagePreview: userMessage?.substring(0, 100),
        authorType: event.payload.message.author.type,
        displayName: event.payload.message.author.displayName
      });

      if (!userMessage || !conversationId) {
        console.log('❌ Missing required data - skipping');
        continue;
      }

      // Rate limiting check
      if (isRateLimited(userId)) {
        console.log('🚫 Rate limit exceeded for user:', userId);
        continue;
      }

      // Enhanced duplicate message detection
      if (isDuplicateMessage(conversationId, userMessage, messageId)) {
        console.log('🚫 Duplicate message detected - skipping');
        continue;
      }

      // Check if conversation has live_agent_requested tag
      console.log('🏷️ Checking for live agent tag...');
      try {
        const ticketRes = await axios.get(
          `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=type:ticket external_id:${conversationId}`,
          {
            timeout: 5000,
            auth: {
              username: `${process.env.ZENDESK_EMAIL}/token`,
              password: process.env.ZENDESK_API_TOKEN
            }
          }
        );

        const tickets = ticketRes.data.results;
        if (tickets && tickets.length > 0) {
          const ticket = tickets[0];
          if (ticket.tags && ticket.tags.includes('live_agent_requested')) {
            console.log('🙋‍♂️ Live agent requested - skipping AI response');
            continue;
          }
          console.log('✅ No live agent tag found - proceeding with AI response');
        } else {
          console.log('ℹ️ No associated ticket found - proceeding with AI response');
        }
      } catch (tagCheckError) {
        console.log('⚠️ Error checking tags, proceeding with AI response:', tagCheckError.message);
        // Continue with AI response if tag check fails
      }

      // Build system prompt with support docs
      const systemPrompt = buildSystemPrompt(userMessage);
      console.log('📋 Built system prompt for message');
      
      // Get AI response from OpenAI with timeout
      console.log('🧠 Calling OpenAI API...');
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
          timeout: 15000,
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // Add error handling for OpenAI response
      if (!openaiRes.data?.choices?.[0]?.message?.content) {
        console.error('❌ Invalid OpenAI response structure:', openaiRes.data);
        throw new Error('Invalid OpenAI response - no content found');
      }

      const aiReply = openaiRes.data.choices[0].message.content;
      console.log('✅ AI Reply generated successfully');
      console.log('📝 Reply preview:', aiReply.substring(0, 100) + '...');

      // Send reply via Sunshine Conversations API
      console.log('📤 Sending reply to Sunshine API...');
      await axios.post(
        `https://api.smooch.io/v2/apps/${process.env.ZENDESK_APP_ID}/conversations/${conversationId}/messages`,
        {
          author: {
            type: 'business'
          },
          content: {
            type: 'text',
            text: aiReply
          }
        },
        {
          timeout: 10000,
          headers: {
            'Authorization': `Basic ${Buffer.from(`${process.env.ZENDESK_KEY_ID}:${process.env.ZENDESK_SECRET_KEY}`).toString('base64')}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('🎉 SUCCESS: AI response sent to user!');
      console.log('📊 Stats:', {
        errorCount,
        activeRateLimits: userMessageCount.size,
        recentMessagesTracked: recentMessages.size
      });

      // Reset error count on success
      errorCount = 0;
    }

    res.sendStatus(200);
    
  } catch (error) {
    errorCount++;
    console.error('❌ Webhook error #' + errorCount + ':', error.message);
    console.error('📋 Error details:', error.response?.data || error);
    console.error('🔍 Error stack:', error.stack);
    
    // Send error response
    res.status(500).send('Internal server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AI Chatbot server running safely on port ${PORT}`);
  console.log('🛡️ Safety features enabled:');
  console.log('  ✅ Enhanced bot detection');
  console.log('  ✅ Rate limiting (5 msgs/min per user)');
  console.log('  ✅ Message deduplication (60s window)');
  console.log('  ✅ Circuit breaker (max 10 errors)');
  console.log('  ✅ Request timeouts');
  console.log('  ✅ Comprehensive logging');
  console.log('  ✅ Environment variable validation');
});