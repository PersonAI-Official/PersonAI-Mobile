/**
 * Typed wrapper around the framework-defined `session.*` RPC methods.
 *
 * `rpc_event.data` is an AG-UI event verbatim. This module never invents a
 * second event vocabulary: it exposes the payload unchanged and only offers
 * small, tolerant helpers to read the fields the app cares about. Unknown event
 * types must be ignored by callers (the helpers simply return null).
 */
import type { SecureTunnel, StreamOptions } from "./tunnel";
import { isRecord } from "./client";
import { translate } from "../i18n";

/* ------------------------------------------------------------------ */
/* Session DTOs (minimum fields defined by the protocol)               */
/* ------------------------------------------------------------------ */

export interface SessionSummary {
  id: string;
  productCode: string;
  title: string;
  updatedAt: string | number;
  status: string;
  workspace?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string | number;
  runId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionListParams {
  cursor?: string | null;
  limit?: number;
  filter?: string | null;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  nextCursor?: string | null;
}

export interface SessionHistoryParams {
  sessionId: string;
  cursor?: string | null;
  limit?: number;
  /** Product context the pack forwards (for example an assistant code). */
  metadata?: Record<string, unknown>;
}

export interface SessionHistoryResult {
  messages: SessionMessage[];
  nextCursor?: string | null;
}

export interface SessionCreateParams {
  title?: string;
  workspace?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionSendMessageParams {
  sessionId: string;
  content: string;
  attachments?: unknown[];
  clientCapabilities?: Record<string, unknown>;
  /**
   * Product-owned model selection. The framework passes it through untouched;
   * the pack forwards it to the node so a run uses the same model the desktop
   * composer picked instead of a placeholder route.
   */
  modelSelection?: Record<string, unknown> | null;
  /** Reasoning effort name (`Low`, `High`, ...), product-owned vocabulary. */
  reasoningEffort?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionStopRunParams {
  sessionId: string;
  runId?: string | null;
  /** Product context the pack forwards (for example an assistant code). */
  metadata?: Record<string, unknown>;
}

export interface SessionStopRunResult {
  cancelled: boolean;
}

export interface SessionWatchEventsParams {
  sessionId: string;
  /** Protocol sequence to resume after; the node replays everything newer. */
  cursor?: number | null;
}

export interface SessionUnwatchEventsParams {
  subscriptionId: string;
}

/* ------------------------------------------------------------------ */
/* AG-UI events                                                        */
/* ------------------------------------------------------------------ */

export interface AgUiEvent {
  type: string;
  [key: string]: unknown;
}

/** Minimal AG-UI event set the protocol requires products to emit. */
export const AGUI_EVENT_TYPES = {
  runStarted: "RUN_STARTED",
  textStart: "TEXT_MESSAGE_START",
  textContent: "TEXT_MESSAGE_CONTENT",
  textEnd: "TEXT_MESSAGE_END",
  toolStart: "TOOL_CALL_START",
  toolArgs: "TOOL_CALL_ARGS",
  toolEnd: "TOOL_CALL_END",
  toolResult: "TOOL_CALL_RESULT",
  runFinished: "RUN_FINISHED",
  runError: "RUN_ERROR",
  custom: "CUSTOM",
} as const;

const KNOWN_AGUI_TYPES = new Set<string>(Object.values(AGUI_EVENT_TYPES));

export function asAgUiEvent(value: unknown): AgUiEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value as AgUiEvent;
}

export function aguiEventType(event: unknown): string | null {
  const parsed = asAgUiEvent(event);
  return parsed ? parsed.type.toUpperCase() : null;
}

export function isKnownAgUiEventType(type: string | null): boolean {
  return type !== null && KNOWN_AGUI_TYPES.has(type);
}

/** Delta text of `TEXT_MESSAGE_CONTENT`; null for any other event. */
export function aguiTextDelta(event: unknown): string | null {
  const parsed = asAgUiEvent(event);
  if (!parsed || parsed.type.toUpperCase() !== AGUI_EVENT_TYPES.textContent) {
    return null;
  }
  return typeof parsed.delta === "string" ? parsed.delta : null;
}

/** Normalized `RUN_ERROR` payload; null when the event is something else. */
export function aguiRunError(
  event: unknown,
): { message: string; code: string } | null {
  const parsed = asAgUiEvent(event);
  if (!parsed || parsed.type.toUpperCase() !== AGUI_EVENT_TYPES.runError) {
    return null;
  }
  const message =
    typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message
      : typeof parsed.code === "string" && parsed.code.trim()
        ? parsed.code
        : translate("回复失败，请重试");
  return {
    message,
    code: typeof parsed.code === "string" ? parsed.code : "RUN_ERROR",
  };
}

export function isRunFinished(event: unknown): boolean {
  return aguiEventType(event) === AGUI_EVENT_TYPES.runFinished;
}

export function isRunStarted(event: unknown): boolean {
  return aguiEventType(event) === AGUI_EVENT_TYPES.runStarted;
}

/* ------------------------------------------------------------------ */
/* Method availability                                                 */
/* ------------------------------------------------------------------ */

export const SESSION_RPC_METHODS = {
  list: "session.list",
  history: "session.history",
  create: "session.create",
  sendMessage: "session.sendMessage",
  stopRun: "session.stopRun",
  watchEvents: "session.watchEvents",
  unwatchEvents: "session.unwatchEvents",
} as const;

export function supportsMethod(methods: string[] | null | undefined, method: string): boolean {
  return Array.isArray(methods) && methods.includes(method);
}

/** Generic chat UI is only shown for nodes that advertise the session RPC. */
export function supportsSessionRpc(methods: string[] | null | undefined): boolean {
  return supportsMethod(methods, SESSION_RPC_METHODS.list);
}

/* ------------------------------------------------------------------ */
/* Stream shapes                                                       */
/* ------------------------------------------------------------------ */

export interface SessionMessageStream {
  /** `rpc_result` of `session.sendMessage`; resolves with the started run id. */
  runId: Promise<string | null>;
  events: AsyncIterable<AgUiEvent>;
  cancel: () => void;
}

export interface SessionWatchStream {
  subscriptionId: Promise<string | null>;
  events: AsyncIterable<AgUiEvent>;
  cancel: () => void;
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function aguiEvents(source: AsyncIterable<unknown>): AsyncIterable<AgUiEvent> {
  return (async function* iterate() {
    for await (const item of source) {
      const event = asAgUiEvent(item);
      // Unknown/malformed events are ignored on purpose.
      if (event) yield event;
    }
  })();
}

/* ------------------------------------------------------------------ */
/* SessionRpc                                                          */
/* ------------------------------------------------------------------ */

export class SessionRpc {
  private readonly tunnel: SecureTunnel;

  constructor(tunnel: SecureTunnel) {
    this.tunnel = tunnel;
  }

  list(params: SessionListParams = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SessionListResult> {
    return this.tunnel.call<SessionListResult>(SESSION_RPC_METHODS.list, params, options);
  }

  history(
    params: SessionHistoryParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SessionHistoryResult> {
    return this.tunnel.call<SessionHistoryResult>(
      SESSION_RPC_METHODS.history,
      params,
      options,
    );
  }

  create(
    params: SessionCreateParams = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SessionSummary> {
    return this.tunnel.call<SessionSummary>(
      SESSION_RPC_METHODS.create,
      params,
      options,
    );
  }

  sendMessage(
    params: SessionSendMessageParams,
    options: StreamOptions = {},
  ): SessionMessageStream {
    const handle = this.tunnel.streamWithResult<unknown, unknown>(
      SESSION_RPC_METHODS.sendMessage,
      params,
      options,
    );
    return {
      runId: handle.result.then(
        (result) => readStringField(result, "runId"),
        () => null,
      ),
      events: aguiEvents(handle.events),
      cancel: handle.cancel,
    };
  }

  stopRun(
    params: SessionStopRunParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SessionStopRunResult> {
    return this.tunnel.call<SessionStopRunResult>(
      SESSION_RPC_METHODS.stopRun,
      params,
      options,
    );
  }

  watchEvents(
    params: SessionWatchEventsParams,
    options: StreamOptions = {},
  ): SessionWatchStream {
    const handle = this.tunnel.streamWithResult<unknown, unknown>(
      SESSION_RPC_METHODS.watchEvents,
      params,
      options,
    );
    return {
      subscriptionId: handle.result.then(
        (result) => readStringField(result, "subscriptionId"),
        () => null,
      ),
      events: aguiEvents(handle.events),
      cancel: handle.cancel,
    };
  }

  unwatchEvents(
    params: SessionUnwatchEventsParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, never>> {
    return this.tunnel.call<Record<string, never>>(
      SESSION_RPC_METHODS.unwatchEvents,
      params,
      options,
    );
  }
}