export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
  from?: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('email delivery is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from:
        message.from ?? process.env.PITOLET_SUPPORT_FROM ?? 'Pitolet Support <support@pitolet.com>',
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected email: ${response.status} ${await response.text()}`);
  }
}
