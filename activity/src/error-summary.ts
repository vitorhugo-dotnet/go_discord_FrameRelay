export function safeErrorSummary(error: unknown): string {
 const details = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown; message?: unknown } : undefined;
 const rawMessage = typeof error === 'string' ? error : typeof details?.message === 'string' ? details.message : '';
 if (!rawMessage) return 'Unknown error';
 const name = typeof details?.name === 'string' ? details.name.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 40) || 'Error' : 'Error';
 const label = typeof details?.code === 'number' && Number.isSafeInteger(details.code) ? `Discord error ${details.code}` : name;
 const message = rawMessage
  .replace(/\b(?:https?|wss?):\/\/\S+/gi, '[redacted URL]')
  .replace(/\b(access_token|refresh_token|client_secret|authorization|token|code)\s*[=:]\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
  .replace(/\s+/g, ' ').slice(0, 180);
 return `${label}: ${message}`;
}
