// Sends email "from the vendor's own mailbox" via the Gmail API, using a
// per-user refresh token obtained through the incremental gmail.send consent
// (see /auth/google/gmail in routes/auth.js). No SMTP, no extra dependency:
// exchange the refresh token for an access token, then POST an RFC822 message
// to Gmail's users.messages.send. Gmail always sends as the authenticated
// account, so the From header is the vendor.

async function accessTokenFromRefresh(refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`gmail_token_refresh_failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  return (await response.json()).access_token;
}

// RFC 2047 encode a header value so non-ASCII (accents) survive.
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds a minimal MIME message. Body is HTML; an optional plain-text
// fallback keeps spam filters happier. `from`/`to` are plain email addresses;
// fromName is used as the display name.
function buildMime({ from, fromName, to, cc, subject, html, replyTo }) {
  const boundary = "b_" + base64url(Buffer.from(String(subject + to))).slice(0, 16);
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean);

  const textFallback = "El documento está adjunto en formato HTML. Si no lo ve, abra este correo en un cliente que soporte HTML.";
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    textFallback,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");

  return headers.join("\r\n") + "\r\n\r\n" + body;
}

export async function sendGmail({ refreshToken, from, fromName, to, cc, subject, html, replyTo }) {
  const accessToken = await accessTokenFromRefresh(refreshToken);
  const raw = base64url(Buffer.from(buildMime({ from, fromName, to, cc, subject, html, replyTo }), "utf8"));
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`gmail_send_failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return await response.json();
}
