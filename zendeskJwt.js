const jwt = require('jsonwebtoken');
require('dotenv').config();

function generateZendeskJwt() {
  const secret = process.env.ZENDESK_SHARED_SECRET;

  const payload = {
    iss: process.env.ZENDESK_APP_ID, // App ID from Sunshine integration
    sub: "admin-bot", // optional: agent ID or bot identifier
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300 // 5-minute token
  };

  return jwt.sign(payload, secret); // HMAC using your shared secret
}

module.exports = generateZendeskJwt;

