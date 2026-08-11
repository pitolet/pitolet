/** Platform administration is deliberately separate from workspace roles. */

function parseEmails(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function platformAdminEmails(): string[] {
  return parseEmails(process.env.PITOLET_ADMIN_EMAILS);
}

export function feedbackNotificationEmails(): string[] {
  const configured = parseEmails(process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS);
  return configured.length > 0 ? configured : platformAdminEmails();
}

export function isPlatformAdmin(email: string): boolean {
  return platformAdminEmails().includes(email.trim().toLowerCase());
}
