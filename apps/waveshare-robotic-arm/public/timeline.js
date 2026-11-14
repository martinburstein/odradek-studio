const STYLE_ID = "robot-activity-timeline-style";
const STYLES = `.robot-timeline{min-width:0}.robot-timeline-list{display:grid;gap:10px;list-style:none;margin:0;padding:0}.robot-timeline-item{min-width:0;border-left:2px solid rgba(255,157,46,.55);padding:8px 12px;background:rgba(0,0,0,.18);overflow-wrap:anywhere}.robot-timeline-item[data-kind="error"]{border-left-color:#ff785e}.robot-timeline-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}.robot-timeline-title{font-weight:700}.robot-timeline-provenance,.robot-timeline-time,.robot-timeline-detail{color:var(--text-muted,#aaa);font-size:.76rem}.robot-timeline-progress{margin-top:7px}.robot-timeline-progress progress{display:block;width:100%;height:10px;margin-top:4px;accent-color:var(--text-hot,#ff9d2e)}@media(max-width:600px){.robot-timeline-meta{align-items:flex-start;flex-direction:column;gap:4px}.robot-timeline-item{padding:10px}}`;

function text(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.slice(0, 240);
  return fallback;
}

function dateInfo(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : { iso: date.toISOString(), label: date.toLocaleString() };
}

function provenance(outcome) {
  switch (outcome) {
    case "sent": return "Sent · delivery only";
    case "acknowledged": return "Acknowledged · transport response";
    case "observed": return "Observed · feedback reported";
    case "simulated": return "Simulated · simulator only";
    case "intent": return "Requested · not evidence of delivery";
    case "unknown": return "Result unknown";
    case "connected": return "Connection reported";
    case "armed": return "Armed state reported";
    case "operator-confirmed": return "Operator confirmed";
    case "queue-stopped": return "Queue stop reported · physical stop unverified";
    default: return "Result unknown";
  }
}

function appendText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

/** Render up to 50 recent activity events using text nodes only. */
export function renderTimeline(container, events) {
  if (!container || typeof container.replaceChildren !== "function") throw new TypeError("container must be a DOM element");
  const style = document.getElementById(STYLE_ID) || document.createElement("style");
  if (!style.isConnected) { style.id = STYLE_ID; style.textContent = STYLES; document.head.append(style); }
  const section = document.createElement("section");
  section.className = "robot-timeline";
  section.setAttribute("aria-label", "Activity timeline");
  const list = document.createElement("ol");
  list.className = "robot-timeline-list";
  const rows = Array.isArray(events) ? events.slice(-50) : [];

  for (const event of rows) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const kind = text(event.kind, "activity");
    const outcome = text(event.outcome, "unknown");
    const item = document.createElement("li");
    item.className = "robot-timeline-item";
    item.dataset.kind = kind === "error" ? "error" : "activity";
    item.setAttribute("aria-label", `${kind}: ${provenance(outcome)}`);
    const meta = document.createElement("div");
    meta.className = "robot-timeline-meta";
    appendText(meta, "span", "robot-timeline-title", text(event.name || event.action || event.taskName || event.kind, "Activity"));
    appendText(meta, "span", "robot-timeline-provenance", provenance(outcome));
    const when = dateInfo(event.at || event.timestamp);
    if (when) {
      const time = document.createElement("time");
      time.className = "robot-timeline-time";
      time.dateTime = when.iso;
      time.textContent = when.label;
      meta.append(time);
    } else appendText(meta, "span", "robot-timeline-time", "Time unavailable");
    item.append(meta);

    if (kind === "error") appendText(item, "p", "robot-timeline-detail", "An error was reported; details are available in the authenticated status view.");
    const completed = typeof event.progress === "number" && Number.isFinite(event.progress) && event.progress >= 0 ? event.progress : null;
    const total = typeof event.total === "number" && Number.isFinite(event.total) && event.total > 0 ? event.total : null;
    const statedPercent = typeof event.progressPercent === "number" && Number.isFinite(event.progressPercent) ? event.progressPercent : null;
    const percent = statedPercent !== null ? statedPercent : completed !== null && total !== null ? completed / total * 100 : null;
    if (completed !== null || percent !== null) {
      const wrap = document.createElement("div");
      wrap.className = "robot-timeline-progress";
      if (percent !== null) {
        const boundedPercent = Math.max(0, Math.min(100, percent));
        const progressText = total !== null && completed !== null
          ? `Task progress: ${completed} of ${total} steps · ${Math.round(boundedPercent)}%`
          : `Task progress: ${Math.round(boundedPercent)}%`;
        appendText(wrap, "span", "", progressText);
        const bar = document.createElement("progress");
        bar.max = 100; bar.value = boundedPercent;
        bar.setAttribute("aria-label", progressText);
        wrap.append(bar);
      } else {
        appendText(wrap, "span", "", `Task progress: ${completed} steps completed`);
      }
      item.append(wrap);
    }
    list.append(item);
  }
  if (!list.childElementCount) appendText(list, "li", "robot-timeline-empty", "No recent activity reported");
  section.append(list);
  container.replaceChildren(section);
  return { destroy() { section.remove(); if (document.querySelectorAll(`style#${STYLE_ID}`).length && !document.querySelector(".robot-timeline")) style.remove(); } };
}
