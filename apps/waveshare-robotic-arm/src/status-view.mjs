const OWNER_KEYS = /^(owner|ownerName)$/i;
const PRIVATE_KEYS = /^(connectionConfig|config|profile)$/i;
const SECRET_FIELD = /(?:token|secret|password|credential|authorization|cookie|apikey|privatekey|secretkey|accesskey)$/;
const NETWORK_FIELD = /^(?:host|hostname|address|port|url|uri|ip|clientip|remoteip)$|(?:host|hostname|address|port|url|uri)$/;
function privateField(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SECRET_FIELD.test(normalized) || NETWORK_FIELD.test(normalized);
}
const validDate = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function clean(value, key = "", depth = 0, { includeOwner = false } = {}) {
  if (privateField(key) || PRIVATE_KEYS.test(key) || (OWNER_KEYS.test(key) && !includeOwner)) return undefined;
  if (depth > 8 || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.slice(-20).map((item) => clean(item, "", depth + 1, { includeOwner })).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name, depth + 1, { includeOwner })]).filter(([, item]) => item !== undefined));
}

function position(value, source, observedAt, includeOwner) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = clean(value, "", 0, { includeOwner });
  if (!data || !Object.keys(data).length) return null;
  return { ...data, source, observedAt: observedAt || null };
}

/** Return a role-aware, provenance-qualified API status snapshot. */
export function projectStatus(status, { now = Date.now(), role = "observer" } = {}) {
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new TypeError("status must be an object");
  const timestamp = validDate(status.telemetryUpdatedAt);
  const timestampMs = timestamp === null ? NaN : Date.parse(timestamp);
  const ageMs = Number.isFinite(timestampMs) ? now - timestampMs : null;
  const mode = typeof status.mode === "string" ? status.mode : "unknown";
  const source = mode === "simulator" ? "simulator" : mode === "hardware" || mode === "serial" ? "hardware" : "unknown";
  const online = status.connected === true && mode !== "disconnected";
  const freshness = !online || (ageMs !== null && ageMs > 15000) ? "offline" : ageMs === null || ageMs < 0 || ageMs > 5000 ? "stale" : "live";
  const includeOwner = role === "control" || role === "admin";
  const measured = source === "hardware" ? position(status.measured, "hardware", timestamp, includeOwner) : null;
  const simulated = source === "simulator" ? position(status.simulated, "simulator", timestamp, includeOwner) : null;
  const commanded = position(status.commanded, "commanded", status.updatedAt ? validDate(status.updatedAt) : null, includeOwner);
  const result = {
    mode,
    connected: status.connected === true,
    armed: status.armed === true,
    commissioned: status.commissioned === true,
    firmware: typeof status.firmware === "string" ? status.firmware : null,
    commanded,
    measured,
    simulated,
    motorHealth: includeOwner && source === 'hardware' ? clean(status.motorHealth, '', 0, { includeOwner }) ?? null : null,
    firmwareCartesian: includeOwner && source === 'hardware' ? clean(status.firmwareCartesian, '', 0, { includeOwner }) ?? null : null,
    telemetryUpdatedAt: timestamp,
    updatedAt: validDate(status.updatedAt),
    freshness,
    freshnessAgeMs: ageMs !== null && ageMs >= 0 ? ageMs : null,
    source,
    task: clean(status.task, "", 0, { includeOwner }) ?? null,
    history: Array.isArray(status.history) ? clean(status.history.slice(-12), "", 0, { includeOwner }) : [],
    poses: Array.isArray(status.poses) ? clean(status.poses.slice(-20), "", 0, { includeOwner }) : [],
    error: clean(status.error, "", 0, { includeOwner }) ?? null,
    limits: clean(status.limits, "", 0, { includeOwner }) ?? null,
    execution: clean(status.execution, "", 0, { includeOwner }) ?? null,
    physicalMovementVerified: status.physicalMovementVerified === true,
    zLift: includeOwner ? clean(status.zLift, '', 0, { includeOwner }) ?? null : { active: status.zLift?.active === true },
    movement: includeOwner ? clean(status.movement, '', 0, { includeOwner }) ?? null : { active: status.movement?.active === true },
  };
  if (role === "control" || role === "admin") result.owner = typeof status.owner === "string" ? status.owner : null;
  return result;
}
