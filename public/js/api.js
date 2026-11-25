// JSON API client.
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.issues = data?.issues || [];
    this.data = data || {};
  }
}

export async function api(path, { method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data);
  return data;
}

const KEY = 'waqt:key';
export const savedKey = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (k) => { try { localStorage.setItem(KEY, k); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

/** Manage key from the URL fragment (#k=…); fragments never reach the server log. */
export function keyFromHash() {
  const m = location.hash.match(/[#&]k=(k_[A-Za-z0-9_-]{16,64})/);
  return m ? m[1] : null;
}
