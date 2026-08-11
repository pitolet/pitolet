type ProblemContext = {
  workspaceId?: string | null;
  documentId?: string | null;
  component?: string;
};

const recent: string[] = [];

function safeText(value: string, maxLength = 1_000): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bptl_[0-9a-f]{40}\b/gi, '[agent-token]')
    .replace(/\bpshare_[A-Za-z0-9_-]{24}\b/g, '[share-token]')
    .replace(/\bpsess_[A-Za-z0-9_-]{32}\b/g, '[share-session]')
    .replace(/([?&](?:token|code|secret|key)=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, maxLength);
}

function safeProblemTitle(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const name = error.name.trim();
  if (name === 'Error' || /^[A-Za-z][A-Za-z0-9]{0,39}(?:Error|Exception)$/.test(name)) {
    return name;
  }
  return 'Error';
}

function safeStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  const frames = error.stack
    .split('\n')
    .filter((line) => /^\s*at\s+/.test(line))
    .slice(0, 20)
    .map((line) => safeText(line, 500));
  return frames.length ? frames.join('\n').slice(0, 8_000) : undefined;
}

export function recentDashboardErrors(): string[] {
  return [...recent];
}

export function reportDashboardProblem(
  error: unknown,
  context: ProblemContext = {},
  fallback = 'Browser error',
): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  const title = safeProblemTitle(error, fallback);
  recent.push(title);
  if (recent.length > 5) recent.shift();
  const stack = safeStack(error);
  void fetch('/api/problems/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'dashboard',
      title,
      stack,
      route: window.location.pathname,
      release: import.meta.env.VITE_PITOLET_RELEASE ?? 'development',
      workspaceId: context.workspaceId ?? null,
      documentId: context.documentId ?? null,
      context: context.component ? { component: context.component } : undefined,
    }),
  }).catch(() => {});
}

export function installDashboardProblemReporter(context: () => ProblemContext): () => void {
  const onError = (event: ErrorEvent) =>
    reportDashboardProblem(event.error ?? event.message, context(), 'Browser error');
  const onRejection = (event: PromiseRejectionEvent) =>
    reportDashboardProblem(event.reason, context(), 'Unhandled promise rejection');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
