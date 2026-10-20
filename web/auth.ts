// Google sign-in for the web viewer (Google Identity Services, token model):
// the browser gets a short-lived (1 h) access token for read-only Drive
// access. No server, no refresh token — when it runs out, one tap on
// "ログイン" gets a new one (Google remembers the consent).

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_KEY = "rmemo.web.token";

interface StoredToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): { requestAccessToken(options?: { prompt?: string }): void };
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      reject(new Error("Google のログイン部品を読み込めませんでした（オフライン？）"));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

/** The saved token if it's still good for at least a minute. */
export function storedToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    return t.expiresAt - 60_000 > Date.now() ? t.token : null;
  } catch {
    return null;
  }
}

export function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Opens Google's sign-in popup — call from a tap/click handler, or the
 *  browser blocks the popup. Resolves to an access token. */
export async function signIn(clientId: string): Promise<string> {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) {
          reject(new Error(r.error_description || r.error || "ログインできませんでした"));
          return;
        }
        const stored: StoredToken = {
          token: r.access_token,
          expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
        };
        try {
          localStorage.setItem(TOKEN_KEY, JSON.stringify(stored));
        } catch {
          /* fine: just not remembered across reloads */
        }
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.message || e.type)),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

export async function signOut() {
  const token = storedToken();
  forgetToken();
  if (token && window.google?.accounts) window.google.accounts.oauth2.revoke(token);
}
