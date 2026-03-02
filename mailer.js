const { Resend } = require('resend');

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'resend';
const MAIL_FROM = process.env.MAIL_FROM || 'Pressboxd <no-reply@example.com>';

let resend = null;
if (EMAIL_PROVIDER === 'resend') {
  resend = new Resend(process.env.RESEND_API_KEY);
}

async function sendTempPasswordEmail({ to, username, tempPassword }) {
  if (!to) throw new Error('Missing recipient email');

  const subject = 'Your Pressboxd temporary password';
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>Pressboxd password reset</h2>
      <p>Hello <b>${escapeHtml(username)}</b>,</p>
      <p>Your temporary password is:</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:1px">${escapeHtml(tempPassword)}</p>
      <p>Please log in and change it immediately.</p>
      <p>If you did not request this, contact support.</p>
    </div>
  `;

  if (EMAIL_PROVIDER === 'resend') {
    const { data, error } = await resend.emails.send({
      from: MAIL_FROM,
      to: [to],
      subject,
      html,
    });

    if (error) throw new Error(error.message || 'Email send failed');
    return data;
  }

  throw new Error(`Unsupported EMAIL_PROVIDER: ${EMAIL_PROVIDER}`);
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = {
  sendTempPasswordEmail,
};
