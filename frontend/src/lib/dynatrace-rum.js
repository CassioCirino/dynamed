function getRumApi() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.dtrum || null;
}

function buildUserTag(user) {
  if (!user) {
    return "anonimo:visitante";
  }
  const role = String(user.role || "usuario").trim() || "usuario";
  const fullName = String(user.full_name || user.name || "").trim();
  const email = String(user.email || "").trim();
  const id = String(user.id || "").trim();
  const identity = fullName || email || id || "desconhecido";
  return `${role}:${identity}`;
}

export function identifyRumUser(user) {
  const rum = getRumApi();
  if (!rum || typeof rum.identifyUser !== "function") {
    return;
  }

  try {
    rum.identifyUser(buildUserTag(user));
  } catch {
    // no-op: do not break app flow if RUM API is unavailable.
  }
}
