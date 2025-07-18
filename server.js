const express = require('express');
const axios = require('axios');
const supportDocs = require('./support_docs');
require('dotenv').config();

const app = express();
app.use(express.json());

// Utility to strip HTML tags from Zendesk latest_comment_html
function stripHtmlTags(text) {
  return text.replace(/<[^>]*>/g, '').trim();
}

// Build system prompt using knowledge base and ticket metadata
function buildSystemPrompt(ticket) {
  const docsFormatted = supportDocs.map(doc => `Q: ${doc.question}\nA: ${doc.answer}`).join('\n\n');

  const requesterName = ticket.name || 'Customer';
  const ticketSubject = ticket.subject || '(no subject)';
  const ticketPriority = ticket.priority || '(no priority)';
  const ticketTags = ticket.tags?.join(', ') || '(no tags)';

  return `
You are a support agent for Hair for Hire, an app that helps customers book hairstylists for home or salon visits.

The customer's name is ${requesterName}.
Their ticket is about: "${ticketSubject}"
Priority: ${ticketPriority}
Tags: ${ticketTags}

Here is our support knowledge base:
${docsFormatted}

Using the above information, professionally respond to the customer's message as clearly, kindly, and helpfully as possible. If you're unsure, give your best helpful response. Do not include any unverified information or sign off with a name.
  `.trim();
}

// Health check route
app.get('/', (req, res) => {
  res.send('✅ Hair for Hire AI bot is live!');
});

// Webhook route from Zendesk
app.post('/webhook', async (req, res) => {
  console.log('✅ Webhook endpoint hit!');
  try {
    const ticket = req.body.ticket || req.body;
    const ticketId = ticket.id;
    const requesterName = ticket.name || 'the customer';
    const ticketSubject = ticket.subject;

    const rawComment = ticket.latest_comment || ticket.description || '';
    const ticketText = stripHtmlTags(rawComment);

    const systemPrompt = buildSystemPrompt(ticket);

    const userPrompt = `
The following message was sent by ${requesterName}.

Subject: ${ticketSubject}
Message: ${ticketText}
    `.trim();

    console.log('--- SYSTEM PROMPT ---\n' + systemPrompt);
    console.log('--- USER PROMPT ---\n' + userPrompt);

    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const aiReply = openaiRes.data.choices[0].message.content;

    const response = await axios.put(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
      {
        ticket: {
          comment: {
            body: aiReply,
            public: true
          },
          author_id: 37412595449115 // Must be a valid AGENT ID
        }
      },
      {
        auth: {
          username: `${process.env.ZENDESK_EMAIL}/token`,
          password: process.env.ZENDESK_API_TOKEN
        },
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    
    console.log(response.data)

    console.log(`✅ AI reply sent to ticket #${ticketId}`);
    res.status(200).send('AI reply added');
  } catch (err) {
    console.error('❌ Error details:', err.response?.data || err.message);
    res.status(500).send('Error processing ticket');
  }
});

// Manual test route
app.post('/test-openai', async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage) {
      return res.status(400).json({ error: 'Missing "message" in request body' });
    }

    const fakeTicket = {
      name: 'Test User',
      subject: 'Test Prompt',
      priority: 'normal',
      tags: ['test']
    };

    const systemPrompt = buildSystemPrompt(fakeTicket);

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
    res.status(200).json({ reply: aiReply });
  } catch (err) {
    console.error('❌ Error in /test-openai:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get response from OpenAI' });
  }
});

app.listen(3000, () => console.log('🚀 Server running at http://localhost:3000'));
