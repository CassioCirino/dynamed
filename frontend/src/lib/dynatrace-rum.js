function getRumApi() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.dtrum || null;
}

const MAX_RETRY_ATTEMPTS = 40;
const RETRY_DELAY_MS = 250;

let retryTimeout = null;
let pendingUserTag = "";

function buildUserTag(user) {
  if (!user) return "";
  const role = String(user.role || "usuario").trim() || "usuario";
  const fullName = String(user.full_name || user.name || "").trim();
  const email = String(user.email || "").trim();
  const id = String(user.id || "").trim();
  const identity = fullName || email || id || "desconhecido";
  return `${role}:${identity}`;
}

function clearRetryTimer() {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
}

function scheduleIdentify(attempt = 0) {
  if (!pendingUserTag) {
    clearRetryTimer();
    return;
  }

  const rum = getRumApi();
  if (rum && typeof rum.identifyUser === "function") {
    try {
      rum.identifyUser(pendingUserTag);
      clearRetryTimer();
    } catch {
      // no-op: retry below if possible.
    }
    return;
  }

  if (attempt >= MAX_RETRY_ATTEMPTS) {
    clearRetryTimer();
    return;
  }

  clearRetryTimer();
  retryTimeout = setTimeout(() => {
    scheduleIdentify(attempt + 1);
  }, RETRY_DELAY_MS);
}

export function identifyRumUser(user) {
  pendingUserTag = buildUserTag(user);
  if (!pendingUserTag) {
    clearRetryTimer();
    return;
  }
  scheduleIdentify(0);
}
