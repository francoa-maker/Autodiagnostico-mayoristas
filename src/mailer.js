// Gmail API mailer. Each message is sent from the connected mailbox of the
// responsible internal user. Supports HTML plus optional PDF/image attachments.
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

function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(String(value))) return String(value);
  return `=?UTF-8?B?${Buffer.from(String(value), "utf8").toString("base64")}?=`;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeFilename(value) {
  return String(value || "archivo").replace(/[\r\n"]/g, "_");
}

function alternativePart({ html, boundary }) {
  const textFallback = "Este correo contiene información de Autodiagnóstico. Abra el mensaje en un cliente compatible con HTML.";
  return [
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
}

function buildMime({ from, fromName, to, cc, subject, html, replyTo, attachments = [] }) {
  const seed = base64url(Buffer.from(String(subject + to + Date.now()))).slice(0, 20);
  const altBoundary = "alt_" + seed;
  const mixedBoundary = "mix_" + seed;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    hasAttachments
      ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
      : `Content-Type: multipart/alternative; boundary="${altBoundary}"`
  ].filter(Boolean);

  if (!hasAttachments) return headers.join("\r\n") + "\r\n\r\n" + alternativePart({ html, boundary: altBoundary });

  const body = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    alternativePart({ html, boundary: altBoundary })
  ];
  for (const attachment of attachments) {
    body.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${safeFilename(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${safeFilename(attachment.filename)}"`,
      "",
      Buffer.from(attachment.content).toString("base64").replace(/(.{76})/g, "$1\r\n"),
      ""
    );
  }
  body.push(`--${mixedBoundary}--`, "");
  return headers.join("\r\n") + "\r\n\r\n" + body.join("\r\n");
}

export async function sendGmail({ refreshToken, from, fromName, to, cc, subject, html, replyTo, attachments = [] }) {
  const accessToken = await accessTokenFromRefresh(refreshToken);
  const raw = base64url(Buffer.from(buildMime({ from, fromName, to, cc, subject, html, replyTo, attachments }), "utf8"));
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`gmail_send_failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return response.json();
}
