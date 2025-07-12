const express = require('express');
const axios = require('axios');
const supportDocs = require('./support_docs');
require('dotenv').config();

const app = express();
app.use(express.json());

// Build the system prompt by embedding all FAQs
function buildSystemPrompt() {
  const docsFormatted = supportDocs.map(doc =>
    `Q: ${doc.question}\nA: ${doc.answer}`
  ).join('\n\n');

  return `
You are a support agent for Hair for Hire, an app that helps customers book hairstylists for home or salon visits.

Here is our support knowledge base:
${docsFormatted}

Using the above information, answer the customer's message as clearly and kindly as possible. If you do not have enough information, respond with your best helpful answer.
  `.trim();
}

app.post('/webhook', async (req, res) => {
  try {
    const ticket = req.body.ticket || req.body;
    const ticketId = ticket.id;
    const ticketText = ticket.description;

    const systemPrompt = buildSystemPrompt();

    // Call OpenAI
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Customer message: "${ticketText}"` }
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const aiReply = openaiRes.data.choices[0].message.content;

    // Send reply to Zendesk
    await axios.put(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
      {
        ticket: {
          comment: {
            body: aiReply,
            public: false, // Set to true if you want customer to see it immediately
          },
        },
      },
      {
        auth: {
          username: `${process.env.ZENDESK_EMAIL}/token`,
          password: process.env.ZENDESK_API_TOKEN,
        },
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`AI reply sent to ticket #${ticketId}`);
    res.status(200).send('AI reply added');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Error processing ticket');
  }
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));
// This server listens for incoming webhook requests from Zendesk,
// processes the ticket using OpenAI's GPT-4 model, and sends the AI-generated response
// back to Zendesk as a private comment on the ticket.
// The support_docs.js file contains FAQs that are used to build the system prompt for the AI model.