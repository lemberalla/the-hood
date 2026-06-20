export interface ChatGptPageSnapshot {
  url?: string;
  title?: string;
  text?: string;
  authSignal?: string | null;
  composerPresent?: boolean;
}

export interface ChatGptPageReadiness {
  authRequired: boolean;
  authenticated: boolean;
  composerReady: boolean;
  ready: boolean;
  issues: string[];
}

const authTextSignals = [
  "log in to chatgpt",
  "sign up to chatgpt",
  "sign up or log in",
  "continue with google",
  "continue with microsoft",
  "continue with apple",
  "welcome back"
];

const uniqueIssues = (issues: string[]): string[] => Array.from(new Set(issues));

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

const authSignalFromUrl = (rawUrl: string | undefined): string | undefined => {
  if (!rawUrl) {
    return undefined;
  }

  try {
    const url = new URL(rawUrl);
    return /\/(auth|login|signup)(\/|$)/i.test(url.pathname) ? url.pathname : undefined;
  } catch {
    return /\/(auth|login|signup)(\/|$)/i.test(rawUrl) ? rawUrl : undefined;
  }
};

const authSignalFromText = (text: string | undefined): string | undefined => {
  if (!text) {
    return undefined;
  }

  const normalized = normalizeText(text);
  return authTextSignals.find((signal) => normalized.includes(signal));
};

export const classifyChatGptPageSnapshot = (snapshot: ChatGptPageSnapshot): ChatGptPageReadiness => {
  const authSignal = snapshot.authSignal ?? authSignalFromUrl(snapshot.url) ?? authSignalFromText(snapshot.text);
  const authRequired = Boolean(authSignal);
  const composerKnown = snapshot.composerPresent !== undefined;
  const composerReady = !authRequired && snapshot.composerPresent === true;
  const authenticated = !authRequired && composerKnown;

  return {
    authRequired,
    authenticated,
    composerReady,
    ready: authenticated && composerReady,
    issues: uniqueIssues([
      ...(authRequired ? ["chatgpt_auth_required"] : []),
      ...(composerKnown && !authRequired && !composerReady ? ["chatgpt_composer_not_ready"] : [])
    ])
  };
};

export const chatGptPageSnapshotExpression = (promptSelector: string): string => `
(() => {
  const promptSelectors = ${JSON.stringify(promptSelector)}.split(',').map((selector) => selector.trim()).filter(Boolean);
  const authSelectors = [
    'a[href*="/auth/login"]',
    'a[href*="/login"]',
    'a[href*="/signup"]',
    'button[data-testid="login-button"]',
    'button[data-testid="signup-button"]'
  ];
  const authTextSignals = ${JSON.stringify(authTextSignals)};
  const text = (document.body?.innerText || '').toLowerCase().replace(/\\s+/g, ' ').trim();
  const authSignal = /\\/(auth|login|signup)(\\/|$)/i.test(location.pathname)
    ? location.pathname
    : authSelectors.some((selector) => document.querySelector(selector))
      ? 'auth selector'
      : authTextSignals.find((signal) => text.includes(signal)) || null;

  return {
    url: location.href,
    title: document.title,
    authSignal,
    composerPresent: promptSelectors.some((selector) => Boolean(document.querySelector(selector)))
  };
})()
`;
