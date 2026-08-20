import { render } from "preact";
import type { RunStatusSummary } from "./run-status.js";
import type { TelemetryRecord } from "./telemetry.js";

type PhaseStarted = Extract<TelemetryRecord, { type: "phase_started" }> & {
  phase: NonNullable<TelemetryRecord["phase"]>;
};
type ToolEvent = Extract<TelemetryRecord, { type: "tool_started" | "tool_finished" }>;
type PhaseSegment = {
  id: string;
  start: PhaseStarted;
  phaseEnd?: Extract<TelemetryRecord, { type: "phase_finished" }>;
  boundary?: TelemetryRecord;
  context?: Extract<TelemetryRecord, { type: "agent_context" }>;
  usage?: Extract<TelemetryRecord, { type: "agent_usage" }>;
  tools: ToolEvent[];
  effectiveEnd: number;
};
type EventPage = {
  events: TelemetryRecord[];
  cursor: number;
  hasMore: boolean;
  integrity: "ok" | "invalid";
};

let inflight = false;
let selectedRun: string | null = null;
let eventCursor = 0;
let eventRows: TelemetryRecord[] = [];
let runsSnapshot = "";
let pendingRuns: { runs: RunStatusSummary[]; snapshot: string } | null = null;
let selectedSegmentId: string | null = null;
let currentSegments: PhaseSegment[] = [];

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`observer element ${id} missing`);
  return element;
}
function text(element: HTMLElement, value: string | null | undefined): void {
  const next = value ?? "—";
  if (element.textContent !== next) element.textContent = next;
}
function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "No activity";
}
function duration(value: number | null | undefined): string {
  return value == null
    ? "—"
    : `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`;
}
function setConnection(label: string, live: boolean): void {
  text($("connection"), label);
  $("connection").classList.toggle("live", live);
}
function showError(message: string): void {
  text($("error"), message);
  $("error").classList.remove("hidden");
}
function clearError(): void {
  $("error").classList.add("hidden");
}
async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Observer request failed");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T;
}

function MetricField({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div class="metric">
      <span class="label">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {value}
        </a>
      ) : (
        <strong>{value}</strong>
      )}
    </div>
  );
}
function RunCard({ run }: { run: RunStatusSummary }) {
  return (
    <a class="run" href={`/runs/${encodeURIComponent(run.runId)}`}>
      <div>
        <span class="label">Run</span>
        <span class="run-id">{run.runId}</span>
      </div>
      <div>
        <span class="label">State</span>
        <span class={`status ${run.status}`}>{run.status.replaceAll("_", " ")}</span>
      </div>
      <div>
        <span class="label">Phase</span>
        <span>{run.phase || "Waiting"}</span>
      </div>
      <div>
        <span class="label">Last activity</span>
        <time>{time(run.lastActivity)}</time>
      </div>
    </a>
  );
}
function RunList({ runs }: { runs: RunStatusSummary[] }) {
  return runs.length ? (
    <>
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} />
      ))}
    </>
  ) : (
    <p class="empty">No runs yet. Start one with the factory skill or run start command.</p>
  );
}
function eventDetail(event: TelemetryRecord): string {
  switch (event.type) {
    case "tool_started":
    case "tool_finished":
      return event.payload.toolName;
    case "gate_finished":
      return `${event.payload.passed ? "Passed" : "Failed"} · ${event.payload.commandCount} commands`;
    case "review_finished":
      return `${event.payload.verdict} · ${event.payload.blockerCount} blockers`;
    case "cleanup_updated":
      return event.payload.cleanup;
    case "failure":
      return event.payload.message;
    case "artifact_available":
      return `${event.payload.name} · ${event.payload.size} bytes`;
    case "publication_completed":
      return `#${event.payload.number} · ${event.payload.url}`;
    case "run_finished":
      return `${event.payload.status} · cleanup ${event.payload.cleanup}`;
    default:
      return "status" in event.payload ? event.payload.status : "";
  }
}
function segments(events: TelemetryRecord[]): PhaseSegment[] {
  return events
    .filter((event): event is PhaseStarted => event.type === "phase_started" && !!event.phase)
    .map((start) => ({
      id: start.phase.id,
      start,
      phaseEnd: events.find(
        (event): event is Extract<TelemetryRecord, { type: "phase_finished" }> =>
          event.type === "phase_finished" &&
          event.phase?.id === start.phase.id &&
          event.seq > start.seq,
      ),
      boundary: events.find(
        (event) =>
          (event.type === "phase_finished" &&
            event.phase?.id === start.phase.id &&
            event.seq > start.seq) ||
          (event.type === "run_finished" && event.seq > start.seq),
      ),
      context: events.find(
        (event): event is Extract<TelemetryRecord, { type: "agent_context" }> =>
          event.type === "agent_context" && event.phase?.id === start.phase.id,
      ),
      usage: events.find(
        (event): event is Extract<TelemetryRecord, { type: "agent_usage" }> =>
          event.type === "agent_usage" && event.phase?.id === start.phase.id,
      ),
      tools: events.filter(
        (event): event is ToolEvent =>
          (event.type === "tool_started" || event.type === "tool_finished") &&
          event.phase?.id === start.phase.id,
      ),
      effectiveEnd: 0,
    }));
}
function SegmentButton({
  segment,
  selected,
  select,
}: {
  segment: PhaseSegment;
  selected: boolean;
  select: () => void;
}) {
  const elapsed =
    (segment.boundary ? Date.parse(segment.boundary.recordedAt) : segment.effectiveEnd) -
    Date.parse(segment.start.recordedAt);
  const status =
    segment.phaseEnd?.payload.status || (segment.boundary ? "interrupted at run end" : "running");
  return (
    <li>
      <button
        type="button"
        class="segment"
        data-segment={segment.id}
        aria-controls="segment-detail"
        aria-pressed={selected ? "true" : "false"}
        style={{ width: `${140 + Math.min(580, Math.max(0, elapsed) / 2000)}px` }}
        onClick={select}
      >
        <strong>
          {segment.start.actor} · {segment.start.phase.name.replaceAll("_", " ")}
        </strong>
        <small>
          {duration(Math.max(0, elapsed))} · {status}
        </small>
      </button>
    </li>
  );
}
function SegmentDetailPanel({ segment }: { segment: PhaseSegment | undefined }) {
  if (!segment) return <p class="empty">No phase telemetry recorded yet.</p>;
  const end = segment.boundary;
  const elapsed =
    (end ? Date.parse(end.recordedAt) : segment.effectiveEnd) -
    Date.parse(segment.start.recordedAt);
  const context = segment.context?.payload;
  const usage = segment.usage?.payload;
  const calls = new Map<
    string,
    {
      start?: Extract<ToolEvent, { type: "tool_started" }>;
      end?: Extract<ToolEvent, { type: "tool_finished" }>;
    }
  >();
  for (const event of segment.tools) {
    const call = calls.get(event.payload.toolCallId) ?? {};
    if (event.type === "tool_started") call.start = event;
    else call.end = event;
    calls.set(event.payload.toolCallId, call);
  }
  return (
    <>
      <h3>{segment.start.phase.name.replaceAll("_", " ")}</h3>
      <div class="detail-list">
        <MetricField label="Actor" value={segment.start.actor} />
        <MetricField
          label="Status"
          value={segment.phaseEnd?.payload.status || (end ? "interrupted at run end" : "running")}
        />
        <MetricField label="Elapsed" value={duration(Math.max(0, elapsed))} />
        <MetricField label="Started" value={time(segment.start.recordedAt)} />
        <MetricField label="Ended" value={end ? time(end.recordedAt) : "In progress"} />
        <MetricField label="Execution model" value={context?.model || "Unavailable"} />
        <MetricField
          label="Execution limits"
          value={
            context?.executionLimits
              ? `${context.executionLimits.contextTokens} context / ${context.executionLimits.maxOutputTokens} output`
              : "Unavailable"
          }
        />
        <MetricField label="Role" value={context?.description || "Unavailable"} />
        <MetricField
          label="Access / thinking"
          value={context ? `${context.access} / ${context.thinking}` : "Unavailable"}
        />
        <MetricField
          label="Declared tools"
          value={context ? context.tools.join(", ") : "Unavailable"}
        />
        <MetricField
          label="Prompt fingerprint"
          value={context?.systemPromptSha256 || "Unavailable"}
        />
        <MetricField label="Prompt body" value="Unavailable by design" />
        <MetricField
          label="Reported tokens"
          value={
            usage
              ? `${usage.total} total (${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write)`
              : "Unavailable"
          }
        />
      </div>
      {calls.size > 0 && (
        <>
          <h4>Tool activity</h4>
          <ol class="tools">
            {[...calls.entries()].map(([toolCallId, call]) => {
              const endMilliseconds = call.end
                ? Date.parse(call.end.recordedAt)
                : segment.boundary
                  ? Date.parse(segment.boundary.recordedAt)
                  : segment.effectiveEnd;
              const callElapsed = call.start
                ? endMilliseconds - Date.parse(call.start.recordedAt)
                : 0;
              return (
                <li key={toolCallId}>
                  {call.start?.payload.toolName ?? call.end?.payload.toolName ?? "unknown"} ·{" "}
                  {call.end
                    ? call.end.payload.isError
                      ? "error"
                      : "completed"
                    : segment.boundary
                      ? "interrupted"
                      : "running"}{" "}
                  · {duration(Math.max(0, callElapsed))}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}
function SummaryGrid({ detail }: { detail: RunStatusSummary }) {
  return (
    <div class="summary-grid">
      <MetricField label="Status" value={detail.status.replaceAll("_", " ")} />
      <MetricField label="Phase" value={detail.phase || "Waiting"} />
      <MetricField label="Runtime" value={duration(detail.runtimeMilliseconds)} />
      <MetricField
        label="Current phase duration"
        value={duration(detail.phaseRuntimeMilliseconds)}
      />
      <MetricField
        label="Latest actor or open tool"
        value={detail.currentTool || detail.actor || "None"}
      />
      <MetricField label="Cleanup" value={detail.cleanup || "Not started"} />
      {detail.pullRequest && (
        <MetricField
          label="Pull request"
          value={`#${detail.pullRequest.number}`}
          href={detail.pullRequest.url}
        />
      )}
    </div>
  );
}
function EventRow({ event }: { event: TelemetryRecord }) {
  return (
    <li class="event">
      <span class="seq">#{event.seq}</span>
      <span class="event-type">{event.type.replaceAll("_", " ")}</span>
      <span class="event-actor">{event.phase?.name || event.actor}</span>
      <span class="event-detail">{eventDetail(event)}</span>
    </li>
  );
}
function EventLog({ events }: { events: TelemetryRecord[] }) {
  return events.length ? (
    <>
      {events.map((event) => (
        <EventRow key={event.seq} event={event} />
      ))}
    </>
  ) : (
    <li class="empty">No telemetry events recorded yet.</li>
  );
}
function selectSegment(segment: PhaseSegment): void {
  selectedSegmentId = segment.id;
  render(
    <>
      {currentSegments.map((item) => (
        <SegmentButton
          key={item.id}
          segment={item}
          selected={item.id === selectedSegmentId}
          select={() => selectSegment(item)}
        />
      ))}
    </>,
    $("timeline"),
  );
  render(<SegmentDetailPanel segment={segment} />, $("segment-detail"));
}
function renderDetail(detail: RunStatusSummary, events: TelemetryRecord[]): void {
  $("run-list").classList.add("hidden");
  $("run-detail").classList.remove("hidden");
  text($("crumb"), detail.runId.slice(0, 8));
  text($("detail-id"), detail.runId);
  const phases = segments(events);
  const previous = selectedSegmentId;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement ? active.dataset.segment : undefined;
  for (const segment of phases)
    if (!segment.boundary)
      segment.effectiveEnd =
        Date.parse(segment.start.recordedAt) +
        (detail.phase === segment.start.phase.name ? detail.phaseRuntimeMilliseconds || 0 : 0);
  const selected =
    phases.find((segment) => segment.id === previous) ||
    phases.findLast((segment) => !segment.boundary) ||
    phases.at(-1);
  const automatic = selected?.id !== previous;
  selectedSegmentId = selected?.id || null;
  currentSegments = phases;
  render(<SummaryGrid detail={detail} />, $("summary"));
  render(
    <>
      {phases.map((segment) => (
        <SegmentButton
          key={segment.id}
          segment={segment}
          selected={segment.id === selectedSegmentId}
          select={() => selectSegment(segment)}
        />
      ))}
    </>,
    $("timeline"),
  );
  render(<SegmentDetailPanel segment={selected} />, $("segment-detail"));
  render(<EventLog events={events} />, $("events"));
  if (focused)
    $("timeline")
      .querySelector<HTMLElement>(`[data-segment="${CSS.escape(focused)}"]`)
      ?.focus({ preventScroll: true });
  else if (automatic)
    $("timeline")
      .querySelector<HTMLElement>(`[data-segment="${CSS.escape(selectedSegmentId || "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function updateRuns(runs: RunStatusSummary[]): void {
  const snapshot = JSON.stringify(runs);
  if (snapshot === runsSnapshot) return;
  const host = $("runs");
  if (host.contains(document.activeElement)) {
    pendingRuns = { runs, snapshot };
    return;
  }
  if (!runsSnapshot) host.replaceChildren();
  render(<RunList runs={runs} />, host);
  runsSnapshot = snapshot;
  pendingRuns = null;
}
async function tick(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const match = location.pathname.match(/^\/runs\/([0-9a-f-]{36})$/);
    if (match) {
      const id = match[1]!;
      if (selectedRun !== id) {
        selectedRun = id;
        eventCursor = 0;
        eventRows = [];
      }
      const detail = await get<RunStatusSummary>(`/api/v1/runs/${id}`);
      let page: EventPage;
      try {
        do {
          page = await get<EventPage>(`/api/v1/runs/${id}/events?after=${eventCursor}&limit=500`);
          if (page.events.length) {
            eventRows = eventRows.concat(page.events);
            eventCursor = page.cursor;
          }
        } while (page.hasMore);
      } catch {
        page = { events: [], cursor: eventCursor, hasMore: false, integrity: "invalid" };
      }
      renderDetail(detail, eventRows);
      if (page.integrity === "invalid") {
        showError("Telemetry events unavailable. Run summary remains available.");
        setConnection("Partial telemetry", false);
      } else {
        clearError();
        setConnection("Live · updates every second", true);
      }
    } else {
      selectedRun = null;
      const data = await get<{ runs: RunStatusSummary[] }>("/api/v1/runs?limit=100");
      updateRuns(data.runs);
      clearError();
      setConnection("Live · updates every second", true);
    }
  } catch {
    showError("Observer unavailable. Retrying…");
    setConnection("Reconnecting", false);
  } finally {
    $("content").removeAttribute("aria-busy");
    inflight = false;
  }
}
if (typeof document !== "undefined") {
  $("runs").addEventListener("focusout", () =>
    queueMicrotask(() => {
      if (pendingRuns && !$("runs").contains(document.activeElement)) {
        const next = pendingRuns;
        render(<RunList runs={next.runs} />, $("runs"));
        runsSnapshot = next.snapshot;
        pendingRuns = null;
      }
    }),
  );
  void tick();
  setInterval(() => void tick(), 1000);
}
