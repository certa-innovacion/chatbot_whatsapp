require('dotenv').config({ override: true });
const axios = require('axios');

const PIN = process.argv[2];
if (!PIN || !/^\d{6}$/.test(PIN)) {
  console.error('Uso: node testPin.js 150954');
  process.exit(1);
}

const url = `https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}`;

axios.post(
  url,
  { pin: PIN },
  {
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }
).then(r => {
  console.log('✅ PIN configurado:', r.data);
}).catch(e => {
  console.error('❌ Error:', e.response?.data || e.message);
});
