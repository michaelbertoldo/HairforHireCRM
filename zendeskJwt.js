const jwt = require('jsonwebtoken');
require('dotenv').config();

function generateZendeskJwt() {
  const appId = process.env.ZENDESK_APP_ID;
  const keyId = process.env.ZENDESK_KEY_ID;
  const secret = process.env.ZENDESK_SECRET_KEY;

  const payload = {
    iss: appId,
    sub: keyId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300 // valid for 5 minutes
  };

  const token = jwt.sign(payload, secret, {
    algorithm: 'HS256',
    header: { kid: keyId }
  });

  return token;
}

module.exports = generateZendeskJwt;

