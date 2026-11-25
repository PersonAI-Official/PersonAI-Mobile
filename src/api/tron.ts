/**
 * Tron product RPC wrappers.
 *
 * `session.*` is the framework-defined generic chat contract (implemented in
 * `rpc.ts`); `tron.*` covers the Tron-specific catalog (workspaces, assistants,
 * projects, directories, session groups, skins). Both travel over the same
 * encrypted tunnel — this module never performs HTTP requests.
 */
import {
  ApiError,
  isRecord,
  requestTronJson,
} from "./client";
import {
  SessionRpc,
  aguiRunError,
  aguiTextDelta,
  isRunFinished,
  type AgUiEvent,
  type SessionSummary,
} from "./rpc";
import type { ChatUserInputAnswer, ChatUserInputRequest } from "@personai/agent-ui-chat-core/headless";
import type { SecureTunnel } from "./tunnel";
import { translate } from "../i18n";

export const TRON_PRODUCT_CODE = "tron";
export const TRON_PRODUCT_NAME = "Tron Harness";

/** `ChatSession.sourceType` of a session opened from an assistant. */
export const ASSISTANT_SOURCE_TYPE = "ASSISTANT";

/** Product-namespace RPC methods registered by `tron-remote-pack`. */
export const TRON_RPC_METHODS = {
  skinsList: "tron.skins.list",
  skinsActive: "tron.skins.active",
  assistantsList: "tron.assistants.list",
  assistantsMainSession: "tron.assistants.mainSession",
  assistantsCreateSession: "tron.assistants.createSession",
  workspacesList: "tron.workspaces.list",
  projectsList: "tron.projects.list",
  directoriesList: "tron.directories.list",
  sessionGroups: "tron.session.groups",
  chatProtocolEvents: "tron.chat.protocolEvents",
  chatSteer: "tron.chat.steer",
  chatSetWorkingDirectory: "tron.chat.setWorkingDirectory",
  chatAnswerUserInput: "tron.chat.answerUserInput",
  chatUploadAttachment: "tron.chat.uploadAttachment",
  chatUserInputRequests: "tron.chat.userInputRequests",
  chatA2uiState: "tron.chat.a2uiState",
  chatA2uiAction: "tron.chat.a2uiAction",
  navigationMenus: "tron.navigation.menus",
  modelsSelectOptions: "tron.models.selectOptions",
} as const;

/** A chat sidebar widget defined by the product's navigation menu. */
export interface NavigationMenu {
  menuCode: string;
  label: string;
  /** `chat.projects`, `chat.directories`, `chat.recents`, ... */
  pageCode: string;
  icon: string | null;
}

export interface SkinResources {
  background?: string | null;
  font?: string | null;
  css?: string | null;
}

export interface SkinVariants {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Mirrors the backend `SkinVo` shape (`camelCase` JSON). */
export interface Skin {
  id: string;
  name: string;
  version: number;
  variants: SkinVariants;
  layout: Record<string, string>;
  resources: SkinResources;
}

export interface Assistant {
  assistantCode: string;
  agentCode: string;
  name: string;
  description: string;
  avatarId?: string | null;
  kind: string;
  enabled: boolean;
  isMain: boolean;
  heartbeatMinutes: number;
  updatedAt: number | string;
}

export interface WorkspaceOption {
  workspaceCode: string;
  label: string;
  name: string;
  description: string | null;
  parentWorkspaceCode: string | null;
  depth: number;
  status: string;
}

export interface ProjectRecord {
  projectCode: string;
  workspaceCode: string;
  name: string;
  updatedAt: string;
}

export interface DirectoryRecord {
  directoryCode: string;
  workspaceCode: string;
  executionHost: string;
  path: string;
  name: string;
  parentDirectoryCode: string | null;
  available: boolean;
}

export type ChatMessageRole = "USER" | "ASSISTANT" | string;

export interface ChatSession {
  id: number | string;
  sessionCode: string;
  workspaceCode: string | null;
  projectCode?: string | null;
  directoryCode?: string | null;
  /** Directory the session currently runs in (`null` = workspace default). */
  workingDirectoryCode?: string | null;
  title: string;
  status: string;
  sourceType?: string | null;
  sourceCode?: string | null;
  agentCode?: string | null;
  lastRunCode?: string | null;
  lastRunStatus?: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface ChatSessionGroup {
  taskCode?: string | null;
  taskTitle: string;
  sourceType?: string | null;
  sourceCode?: string | null;
  sessions: ChatSession[];
}

export interface ChatMessage {
  id: number | string;
  messageCode: string;
  sessionCode: string;
  runCode?: string | null;
  role: ChatMessageRole;
  channel: string;
  actor: string;
  content: string;
  attachments?: unknown[];
  /** A2UI envelopes, when the node presents a surface in this message. */
  a2ui?: { messages: unknown[]; surfaceIds?: string[] };
  createdAt: string | number;
}

export interface ChatSendResult {
  session?: ChatSession;
  messages: ChatMessage[];
  run?: Record<string, unknown>;
}

/** Business calls only need the secure tunnel; there is no token/URL pair. */
export interface TronConnection {
  tunnel: SecureTunnel;
}

interface ApiParams extends TronConnection {
  signal?: AbortSignal;
  assistantCode?: string | null;
  workspaceCode?: string | null;
}

function workspaceParam(
  workspaceCode: string | null | undefined,
): { workspaceCode: string } | undefined {
  const trimmed = workspaceCode?.trim();
  return trimmed ? { workspaceCode: trimmed } : undefined;
}

function scopeParam(
  params: ApiParams,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...workspaceParam(params.workspaceCode),
    ...(params.assistantCode?.trim()
      ? { assistantCode: params.assistantCode.trim() }
      : {}),
    ...extra,
  };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readScalar(record: Record<string, unknown>, key: string): string | number | null {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function metadataOf(value: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value.metadata) ? value.metadata : {};
}

/**
 * Normalizes a generic `SessionSummary` (protocol fields) into the Tron-shaped
 * `ChatSession` used by the screens. Tron packs may include extra fields either
 * directly or under `metadata`; generic packs only need `id/title/status`.
 */
export function normalizeChatSession(
  value: unknown,
  fallbackMessage: string,
): ChatSession {
  if (!isRecord(value)) {
    throw new ApiError(fallbackMessage, { code: "INVALID_SESSION" });
  }
  const metadata = metadataOf(value);
  const sessionCode = readString(value, "sessionCode") ?? readString(value, "id");
  if (!sessionCode) {
    throw new ApiError(fallbackMessage, { code: "INVALID_SESSION" });
  }
  const workspaceCode =
    readString(value, "workspaceCode") ??
    readString(metadata, "workspaceCode") ??
    readString(value, "workspace");
  const now = new Date().toISOString();
  return {
    id: readScalar(value, "id") ?? sessionCode,
    sessionCode,
    workspaceCode,
    projectCode: readString(value, "projectCode") ?? readString(metadata, "projectCode"),
    directoryCode:
      readString(value, "directoryCode") ?? readString(metadata, "directoryCode"),
    workingDirectoryCode:
      readString(value, "workingDirectoryCode") ??
      readString(metadata, "workingDirectoryCode"),
    title: readString(value, "title") ?? "",
    status: readString(value, "status") ?? "",
    sourceType: readString(value, "sourceType") ?? readString(metadata, "sourceType"),
    sourceCode: readString(value, "sourceCode") ?? readString(metadata, "sourceCode"),
    agentCode: readString(value, "agentCode") ?? readString(metadata, "agentCode"),
    lastRunCode:
      readString(value, "lastRunCode") ?? readString(metadata, "lastRunCode"),
    lastRunStatus:
      readString(value, "lastRunStatus") ?? readString(metadata, "lastRunStatus"),
    createdAt: readScalar(value, "createdAt") ?? now,
    updatedAt: readScalar(value, "updatedAt") ?? now,
  };
}

function normalizeSessionMessage(
  value: unknown,
  sessionCode: string,
): ChatMessage | null {
  if (!isRecord(value)) return null;
  const id = readScalar(value, "id") ?? readString(value, "messageCode");
  if (id === null) return null;
  const metadata = metadataOf(value);
  const role = (readString(value, "role") ?? "USER").toUpperCase();
  return {
    id,
    messageCode:
      readString(value, "messageCode") ??
      readString(metadata, "messageCode") ??
      String(id),
    sessionCode:
      readString(value, "sessionCode") ??
      readString(metadata, "sessionCode") ??
      sessionCode,
    runCode:
      readString(value, "runCode") ??
      readString(value, "runId") ??
      readString(metadata, "runCode"),
    role,
    channel: readString(value, "channel") ?? "MAIN_AGENT",
    actor: readString(value, "actor") ?? (role === "USER" ? "user" : "assistant"),
    content: typeof value.content === "string" ? value.content : "",
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
    createdAt: readScalar(value, "createdAt") ?? new Date().toISOString(),
  };
}

function messageListFrom(value: unknown, sessionCode: string): ChatMessage[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.messages)
      ? value.messages
      : [];
  return source
    .map((entry) => normalizeSessionMessage(entry, sessionCode))
    .filter((entry): entry is ChatMessage => entry !== null);
}

function chatMessagesFrom(value: unknown, sessionCode: string): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeSessionMessage(entry, sessionCode))
    .filter((entry): entry is ChatMessage => entry !== null);
}

function normalizeChatSendResult(
  value: unknown,
  sessionCode: string,
): ChatSendResult {
  if (!isRecord(value)) return { messages: [] };
  return {
    session: isRecord(value.session)
      ? (value.session as unknown as ChatSession)
      : undefined,
    // The run's own messages travel with `RUN_FINISHED`; normalizing them here
    // means the screen can show a reply even when the history reload misses it.
    messages: chatMessagesFrom(value.messages, sessionCode),
    run: isRecord(value.run) ? value.run : undefined,
  };
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function normalizeSkin(value: unknown): Skin | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return null;
  }
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  const variants = isRecord(value.variants) ? value.variants : {};
  const resources = isRecord(value.resources) ? value.resources : {};
  const resourcePath = (entry: unknown) =>
    typeof entry === "string" ? entry : null;
  return {
    id: value.id,
    name: value.name,
    version: typeof value.version === "number" ? value.version : 0,
    variants: {
      light: normalizeRecord(variants.light),
      dark: normalizeRecord(variants.dark),
    },
    layout: normalizeRecord(value.layout),
    resources: {
      background: resourcePath(resources.background),
      font: resourcePath(resources.font),
      css: resourcePath(resources.css),
    },
  };
}

function normalizeDirectory(value: unknown): DirectoryRecord | null {
  if (!isRecord(value) || typeof value.directoryCode !== "string") return null;
  return {
    directoryCode: value.directoryCode,
    workspaceCode:
      typeof value.workspaceCode === "string" ? value.workspaceCode : "",
    executionHost:
      typeof value.executionHost === "string" ? value.executionHost : "",
    path: typeof value.path === "string" ? value.path : "",
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name
        : value.directoryCode,
    parentDirectoryCode:
      typeof value.parentDirectoryCode === "string"
        ? value.parentDirectoryCode
        : null,
    available: value.available !== false,
  };
}

function normalizeGroup(value: unknown): ChatSessionGroup | null {
  if (!isRecord(value)) return null;
  const sessions = Array.isArray(value.sessions)
    ? value.sessions
        .map((entry) => {
          try {
            return normalizeChatSession(entry, translate("会话数据无效"));
          } catch {
            return null;
          }
        })
        .filter((entry): entry is ChatSession => entry !== null)
    : [];
  return {
    taskCode: typeof value.taskCode === "string" ? value.taskCode : null,
    taskTitle:
      typeof value.taskTitle === "string" && value.taskTitle.trim()
        ? value.taskTitle
        : translate("会话"),
    sourceType: typeof value.sourceType === "string" ? value.sourceType : null,
    sourceCode: typeof value.sourceCode === "string" ? value.sourceCode : null,
    sessions,
  };
}

/* ------------------------------------------------------------------ */
/* Model catalog                                                       */
/* ------------------------------------------------------------------ */

/**
 * Model selection as the node defines it. The server owns this vocabulary; the
 * app only passes the value it received from `tron.models.selectOptions`.
 */
export interface ModelSelection {
  kind: "Auto" | "Fixed" | "ProviderRoute" | string;
  providerCode?: string | null;
  modelCode?: string | null;
  qualityType?: string | null;
  routeCode?: string | null;
}

export type ReasoningEffort =
  | "None"
  | "Minimal"
  | "Low"
  | "Medium"
  | "High"
  | "XHigh"
  | "Max"
  | "Ultra";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "None",
  "Minimal",
  "Low",
  "Medium",
  "High",
  "XHigh",
  "Max",
  "Ultra",
];

/** One entry of the desktop composer's model menu. */
export interface ModelSelectOption {
  optionCode: string;
  /** Runtime code the node accepted before selections existed. */
  modelCode: string;
  displayName: string;
  modelName: string;
  /** `TEXT`, `EMBEDDING`, `RERANK`, ... — only text models are chattable. */
  modelType: string;
  enabled: boolean;
  /** Server-owned selection; this is what `session.sendMessage` forwards. */
  modelSelection: ModelSelection | null;
  providerCode: string | null;
  accessPlatform: string | null;
  upstreamVendorName: string | null;
  vendor: string | null;
  qualityType: "High" | "Middle" | "Low" | string | null;
  contextWindowTokens: number | null;
  /** Billing multiplier shown next to fixed Person-AI models. */
  outputCoefficient: number | null;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort | null;
  isDefault: boolean;
}

function readModelSelection(value: unknown): ModelSelection | null {
  if (!isRecord(value)) return null;
  const kind = readString(value, "kind");
  if (!kind) return null;
  return {
    kind,
    providerCode: readString(value, "providerCode"),
    modelCode: readString(value, "modelCode"),
    qualityType: readString(value, "qualityType"),
    routeCode: readString(value, "routeCode"),
  };
}

function readEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") return null;
  return (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : null;
}

function normalizeModelOption(value: unknown): ModelSelectOption | null {
  if (!isRecord(value)) return null;
  const optionCode = readString(value, "optionCode");
  const displayName = readString(value, "displayName");
  if (!optionCode || !displayName) return null;
  return {
    optionCode,
    modelCode: readString(value, "modelCode") ?? "",
    displayName,
    modelName: readString(value, "modelName") ?? "",
    modelType: readString(value, "modelType") ?? "TEXT",
    enabled: value.enabled !== false,
    modelSelection: readModelSelection(value.modelSelection),
    providerCode: readString(value, "providerCode"),
    accessPlatform: readString(value, "accessPlatform"),
    upstreamVendorName: readString(value, "upstreamVendorName"),
    vendor: readString(value, "vendor"),
    qualityType: readString(value, "qualityType"),
    contextWindowTokens:
      typeof value.contextWindowTokens === "number"
        ? value.contextWindowTokens
        : null,
    outputCoefficient:
      typeof value.outputCoefficient === "number" &&
      Number.isFinite(value.outputCoefficient)
        ? value.outputCoefficient
        : null,
    supportedReasoningEfforts: Array.isArray(value.supportedReasoningEfforts)
      ? value.supportedReasoningEfforts
          .map(readEffort)
          .filter((entry): entry is ReasoningEffort => entry !== null)
      : [],
    defaultReasoningEffort: readEffort(value.defaultReasoningEffort),
    isDefault: value.isDefault === true,
  };
}

/** True for the node's "对话自动路由" option (Auto or Person-AI ChatAuto). */
export function isAutoModelOption(option: ModelSelectOption): boolean {
  const selection = option.modelSelection;
  return (
    selection?.kind === "Auto" ||
    (selection?.kind === "ProviderRoute" && selection.routeCode === "ChatAuto")
  );
}

/**
 * Picks the option the desktop composer starts with: the auto route first, then
 * the node's default, then the first enabled option.
 */
export function defaultModelOption(
  options: ModelSelectOption[],
): ModelSelectOption | null {
  const enabled = options.filter((option) => option.enabled);
  return (
    enabled.find(isAutoModelOption) ??
    enabled.find((option) => option.isDefault) ??
    enabled[0] ??
    options[0] ??
    null
  );
}

/** `tron.models.selectOptions` — models the desktop composer offers. */
export async function listModelSelectOptions(
  params: ApiParams,
): Promise<ModelSelectOption[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.modelsSelectOptions,
    workspaceParam(params.workspaceCode),
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => normalizeModelOption(entry))
    // The node lists every model class; the composer only ever chats with text
    // models, exactly like the desktop selector.
    .filter(
      (entry): entry is ModelSelectOption =>
        entry !== null && entry.modelType.toUpperCase() === "TEXT",
    );
}

/* ------------------------------------------------------------------ */
/* Tron product methods                                                */
/* ------------------------------------------------------------------ */

async function callTron<T>(
  params: ApiParams,
  method: string,
  rpcParams?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  return requestTronJson<T>({
    tunnel: params.tunnel,
    method,
    params: rpcParams,
    signal: params.signal,
    timeoutMs,
  });
}

/**
 * `tron.navigation.menus` — the product's chat sidebar widgets. The client
 * renders these labels in order instead of hard-coding section names.
 */
export async function listNavigationMenus(
  params: ApiParams,
): Promise<NavigationMenu[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.navigationMenus,
    workspaceParam(params.workspaceCode),
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((entry): NavigationMenu | null => {
      if (!isRecord(entry)) return null;
      const menuCode = readString(entry, "menuCode");
      const label = readString(entry, "label");
      const pageCode = readString(entry, "pageCode");
      if (!label || !pageCode) return null;
      return {
        menuCode: menuCode ?? pageCode,
        label,
        pageCode,
        icon: readString(entry, "icon"),
      };
    })
    .filter((menu): menu is NavigationMenu => menu !== null);
}

/** `tron.skins.list` — read-only skins installed on the node. */
export async function listSkins(
  params: ApiParams & { timeoutMs?: number },
): Promise<Skin[]> {
  const data = await requestTronJson<unknown>({
    tunnel: params.tunnel,
    method: TRON_RPC_METHODS.skinsList,
    params: workspaceParam(params.workspaceCode),
    timeoutMs: params.timeoutMs ?? 12_000,
    signal: params.signal,
  });
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => normalizeSkin(entry))
    .filter((skin): skin is Skin => skin !== null);
}

/** `tron.skins.active` — the node's currently active skin (read only). */
export async function getActiveSkin(
  params: ApiParams & { timeoutMs?: number },
): Promise<{ skin: Skin } | null> {
  const data = await requestTronJson<unknown>({
    tunnel: params.tunnel,
    method: TRON_RPC_METHODS.skinsActive,
    params: workspaceParam(params.workspaceCode),
    timeoutMs: params.timeoutMs ?? 12_000,
    signal: params.signal,
  });
  if (!isRecord(data)) return null;
  const skin = normalizeSkin(data.skin);
  return skin ? { skin } : null;
}

/** `tron.assistants.list` — assistants available in the workspace. */
export async function listAssistants(params: ApiParams): Promise<Assistant[]> {
  const data = await callTron<Assistant[]>(
    params,
    TRON_RPC_METHODS.assistantsList,
    workspaceParam(params.workspaceCode),
  );
  return Array.isArray(data) ? data : [];
}

/** `tron.assistants.mainSession` — creates a session with the main assistant. */
export async function createMainAssistantSession(
  params: ApiParams,
): Promise<ChatSession> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.assistantsMainSession,
    workspaceParam(params.workspaceCode),
    45_000,
  );
  return normalizeChatSession(data, translate("电脑没有返回有效的个人助手会话"));
}

/** `tron.assistants.createSession` — creates a session for a specific assistant. */
export async function createAssistantSession(
  params: ApiParams & { assistantCode: string },
): Promise<ChatSession> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.assistantsCreateSession,
    { assistantCode: params.assistantCode, ...workspaceParam(params.workspaceCode) },
    45_000,
  );
  return normalizeChatSession(data, translate("电脑没有返回有效的个人助手会话"));
}

/** `tron.workspaces.list` — workspace options. */
export async function listWorkspaceOptions(
  params: ApiParams,
): Promise<WorkspaceOption[]> {
  const data = await callTron<WorkspaceOption[]>(
    params,
    TRON_RPC_METHODS.workspacesList,
    workspaceParam(params.workspaceCode),
  );
  return Array.isArray(data) ? data : [];
}

/** `tron.projects.list` — projects in a workspace. */
export async function listProjects(
  params: ApiParams & { workspaceCode: string },
): Promise<ProjectRecord[]> {
  const data = await callTron<ProjectRecord[]>(
    params,
    TRON_RPC_METHODS.projectsList,
    { workspaceCode: params.workspaceCode },
  );
  return Array.isArray(data) ? data : [];
}

/** `tron.directories.list` — registered directories in a workspace. */
export async function listDirectories(
  params: ApiParams & { workspaceCode: string },
): Promise<DirectoryRecord[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.directoriesList,
    { workspaceCode: params.workspaceCode },
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => normalizeDirectory(entry))
    .filter((entry): entry is DirectoryRecord => entry !== null);
}

/** `tron.session.groups` — Tron's topic/directory/chats grouping. */
export async function listSessionGroupsPage(
  params: ApiParams & { workspaceCode: string; cursor?: string | null },
): Promise<{ groups: ChatSessionGroup[]; nextCursor: string | null }> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.sessionGroups,
    { workspaceCode: params.workspaceCode, cursor: params.cursor ?? null, limit: 50 },
  );
  const records = Array.isArray(data) ? data : isRecord(data) ? data.groups : null;
  const groups = (Array.isArray(records) ? records : [])
    .map((entry) => normalizeGroup(entry))
    .filter((entry): entry is ChatSessionGroup => entry !== null);
  return {
    groups,
    nextCursor: isRecord(data) && typeof data.nextCursor === "string" ? data.nextCursor : null,
  };
}

export async function listSessionGroups(
  params: ApiParams & { workspaceCode: string },
): Promise<ChatSessionGroup[]> {
  const groups: ChatSessionGroup[] = [];
  let cursor: string | null = null;
  do {
    const page = await listSessionGroupsPage({ ...params, cursor });
    groups.push(...page.groups);
    cursor = page.nextCursor;
  } while (cursor);
  return groups;
}

/** `tron.chat.protocolEvents` — replay of AG-UI events for one session. */
export async function listChatProtocolEvents(
  params: ApiParams & { sessionCode: string },
): Promise<AgUiEvent[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatProtocolEvents,
    scopeParam(params, { sessionCode: params.sessionCode }),
    20_000,
  );
  if (!Array.isArray(data)) return [];
  return data
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => entry as AgUiEvent);
}

/** `tron.chat.steer` — inserts guidance into the active run. */
export async function steerChatMessage(
  params: ApiParams & { sessionCode: string; runId: string; content: string },
): Promise<ChatMessage | null> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatSteer,
    scopeParam(params, {
      sessionCode: params.sessionCode,
      runId: params.runId,
      content: params.content,
    }),
    20_000,
  );
  if (!isRecord(data)) return null;
  return normalizeSessionMessage(data.message, params.sessionCode);
}

/**
 * `tron.chat.setWorkingDirectory` — moves the session to a directory of its
 * workspace (`null` clears the override). Mirrors the desktop composer's
 * working-directory control.
 */
export async function setChatWorkingDirectory(
  params: ApiParams & { sessionCode: string; directoryCode: string | null },
): Promise<ChatSession | null> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatSetWorkingDirectory,
    scopeParam(params, {
      sessionCode: params.sessionCode,
      directoryCode: params.directoryCode,
    }),
    20_000,
  );
  if (!isRecord(data)) return null;
  return normalizeChatSession(data, translate("电脑没有返回有效的会话"));
}

/** `tron.chat.answerUserInput` — resumes an ask-user/approval pause. */
export interface ChatResumeEntryInput {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload: unknown;
}

export interface AnswerChatUserInputParams extends ApiParams {
  sessionCode: string;
  requestCode: string;
  answers?: unknown[];
  resume?: ChatResumeEntryInput[];
  a2uiMetadata?: unknown;
}

export async function answerChatUserInput(
  params: AnswerChatUserInputParams,
): Promise<AgUiEvent[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatAnswerUserInput,
    scopeParam(params, {
      sessionCode: params.sessionCode,
      requestCode: params.requestCode,
      answers: params.answers ?? [],
      resume: params.resume ?? [],
      ...(params.a2uiMetadata !== undefined
        ? { a2uiMetadata: params.a2uiMetadata }
        : {}),
      clientCapabilities: { userInputRequests: true },
    }),
    180_000,
  );
  return Array.isArray(data)
    ? data
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => entry as AgUiEvent)
    : [];
}

function normalizeUserInputRequest(
  value: unknown,
  sessionCode: string,
): ChatUserInputRequest | null {
  if (!isRecord(value)) return null;
  const requestId =
    readString(value, "requestCode") ?? readString(value, "requestId");
  if (!requestId) return null;
  const questions = Array.isArray(value.questions)
    ? value.questions
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((question) => ({
          questionId: String(
            readString(question, "questionCode") ??
              readString(question, "questionId") ??
              readScalar(question, "id") ??
              "",
          ),
          question: readString(question, "question") ?? "",
          options: Array.isArray(question.options)
            ? question.options
                .filter((entry): entry is Record<string, unknown> => isRecord(entry))
                .map((option) => ({
                  optionId: String(
                    readString(option, "optionCode") ??
                      readString(option, "optionId") ??
                      readScalar(option, "id") ??
                      "",
                  ),
                  label: readString(option, "label") ?? "",
                  description: readString(option, "description") ?? undefined,
                }))
            : [],
          allowCustomAnswer: true,
          allowSkip: true,
        }))
    : [];
  const answers = Array.isArray(value.answers)
    ? value.answers
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((answer) => ({
          questionId: String(
            readString(answer, "questionCode") ??
              readString(answer, "questionId") ??
              "",
          ),
          answerKind:
            readString(answer, "answerKind") === "Option"
              ? ("Option" as const)
              : readString(answer, "answerKind") === "Skipped"
                ? ("Skipped" as const)
                : ("Other" as const),
          optionId:
            readString(answer, "optionCode") ??
            readString(answer, "optionId") ??
            null,
          otherText: readString(answer, "otherText") ?? null,
        }))
    : null;
  const status = readString(value, "status") === "Answered" ? "Answered" : "Pending";
  return {
    requestId,
    sessionId: readString(value, "sessionCode") ?? sessionCode,
    runId: readString(value, "runCode") ?? "",
    assistantMessageId: readString(value, "assistantMessageCode"),
    intro: readString(value, "intro") ?? "",
    questions,
    answers,
    status,
    requestedAt:
      typeof value.requestedAt === "number" ? value.requestedAt : Date.now(),
    answeredAt:
      typeof value.answeredAt === "number" ? value.answeredAt : null,
    ...(status === "Pending" && questions.length
      ? {
          nativeInteraction: {
            questionnaire: true,
            reason: "input_required",
            responseSchema: {},
            optionPayloads: {},
          },
        }
      : {}),
  };
}

/** `tron.chat.userInputRequests` — durable answered/pending interaction history. */
export async function listChatUserInputRequests(
  params: ApiParams & { sessionCode: string },
): Promise<ChatUserInputRequest[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatUserInputRequests,
    scopeParam(params, { sessionCode: params.sessionCode }),
    20_000,
  );
  const source = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.data)
      ? data.data
      : [];
  return source
    .map((entry) => normalizeUserInputRequest(entry, params.sessionCode))
    .filter((entry): entry is ChatUserInputRequest => entry !== null);
}

export interface ChatAttachment {
  id: string;
  kind: string;
  title?: string | null;
  summary: string;
  imageUrl?: string | null;
  resourceCode?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  metadata: Record<string, unknown>;
}

export interface UploadChatAttachmentParams extends ApiParams {
  sessionCode: string;
  fileName: string;
  contentType?: string | null;
  dataBase64: string;
  kind?: "file" | "image" | "inspection";
  summary?: string;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  if (!id) return null;
  return {
    id,
    kind: readString(value, "kind") ?? "file",
    title: readString(value, "title"),
    summary: readString(value, "summary") ?? id,
    imageUrl: readString(value, "imageUrl"),
    resourceCode: readString(value, "resourceCode"),
    fileName: readString(value, "fileName"),
    contentType: readString(value, "contentType"),
    byteSize:
      typeof value.byteSize === "number" ? value.byteSize : null,
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

/** `tron.chat.uploadAttachment` — stage one pasted/picked file for a message. */
export async function uploadChatAttachment(
  params: UploadChatAttachmentParams,
): Promise<ChatAttachment> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatUploadAttachment,
    scopeParam(params, {
      sessionCode: params.sessionCode,
      fileName: params.fileName,
      contentType: params.contentType ?? "application/octet-stream",
      dataBase64: params.dataBase64,
      kind: params.kind ?? "file",
      summary: params.summary ?? params.fileName,
    }),
    180_000,
  );
  const attachment = normalizeChatAttachment(data);
  if (!attachment) throw new Error(translate("电脑没有返回有效的附件信息"));
  return attachment;
}

/** Canonical A2UI state used to hydrate native surfaces and actions. */
export interface ChatA2uiStatePayload {
  sessionId: string;
  revision: number;
  surfaces: Array<Record<string, unknown>>;
  pendingInteractions: Array<Record<string, unknown>>;
}

export async function getChatA2uiState(
  params: ApiParams & { sessionCode: string },
): Promise<ChatA2uiStatePayload | null> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatA2uiState,
    scopeParam(params, { sessionCode: params.sessionCode }),
    20_000,
  );
  if (!isRecord(data)) return null;
  const surfaces = Array.isArray(data.surfaces)
    ? data.surfaces.filter((entry): entry is Record<string, unknown> =>
        isRecord(entry),
      )
    : [];
  const pendingInteractions = Array.isArray(data.pendingInteractions)
    ? data.pendingInteractions.filter((entry): entry is Record<string, unknown> =>
        isRecord(entry),
      )
    : [];
  return {
    sessionId:
      typeof data.sessionId === "string" ? data.sessionId : params.sessionCode,
    revision: typeof data.revision === "number" ? data.revision : 0,
    surfaces,
    pendingInteractions,
  };
}

export interface RunChatA2uiActionParams extends ApiParams {
  sessionCode: string;
  actionId: string;
  surfaceInstanceId: string;
  expectedRevision: number;
  message: unknown;
  metadata: unknown;
}

export async function runChatA2uiAction(
  params: RunChatA2uiActionParams,
): Promise<AgUiEvent[]> {
  const data = await callTron<unknown>(
    params,
    TRON_RPC_METHODS.chatA2uiAction,
    scopeParam(params, {
      sessionCode: params.sessionCode,
      actionId: params.actionId,
      surfaceInstanceId: params.surfaceInstanceId,
      expectedRevision: params.expectedRevision,
      message: params.message,
      metadata: params.metadata,
    }),
    180_000,
  );
  return Array.isArray(data)
    ? data
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => entry as AgUiEvent)
    : [];
}

/* ------------------------------------------------------------------ */
/* Generic session.* methods (used by the chat screen)                 */
/* ------------------------------------------------------------------ */

/**
 * `session.create` — starts a new chat session. A session started from a
 * project/directory group keeps that context, so it is listed under the group
 * it was created from instead of falling back to "随聊".
 */
export async function createChatSession(
  params: ApiParams & {
    workspaceCode: string;
    projectCode?: string | null;
    directoryCode?: string | null;
    workingDirectoryCode?: string | null;
  },
): Promise<ChatSession> {
  const rpc = new SessionRpc(params.tunnel);
  const summary: SessionSummary = await rpc.create(
    {
      workspace: params.workspaceCode,
      metadata: {
        workspaceCode: params.workspaceCode,
        ...(params.projectCode ? { projectCode: params.projectCode } : {}),
        ...(params.directoryCode ? { directoryCode: params.directoryCode } : {}),
        ...(params.workingDirectoryCode
          ? { workingDirectoryCode: params.workingDirectoryCode }
          : {}),
      },
    },
    { signal: params.signal, timeoutMs: 20_000 },
  );
  return normalizeChatSession(summary, translate("电脑没有返回有效的新会话"));
}

/** `session.history` — messages of one session. */
export async function listChatMessages(
  params: ApiParams & { sessionCode: string; workspaceCode?: string },
): Promise<ChatMessage[]> {
  const rpc = new SessionRpc(params.tunnel);
  const result = await rpc.history(
    {
      sessionId: params.sessionCode,
      limit: 200,
      // Sessions live inside one workspace; the node scopes its read by it.
      metadata: {
        ...(params.workspaceCode ? { workspaceCode: params.workspaceCode } : {}),
        ...(params.assistantCode ? { assistantCode: params.assistantCode } : {}),
      },
    },
    { signal: params.signal, timeoutMs: 20_000 },
  );
  const source = isRecord(result) ? result.messages : result;
  return messageListFrom(source, params.sessionCode);
}

/** `session.stopRun` — cancels the active run (optionally one specific run). */
export async function stopChatRun(
  params: ApiParams & {
    sessionCode: string;
    runId?: string | null;
    workspaceCode?: string;
  },
): Promise<boolean> {
  const rpc = new SessionRpc(params.tunnel);
  const result = await rpc.stopRun(
    {
      sessionId: params.sessionCode,
      runId: params.runId ?? null,
      metadata: {
        ...(params.workspaceCode ? { workspaceCode: params.workspaceCode } : {}),
        ...(params.assistantCode ? { assistantCode: params.assistantCode } : {}),
      },
    },
    { signal: params.signal, timeoutMs: 15_000 },
  );
  return result?.cancelled === true;
}

export interface StreamChatParams extends ApiParams {
  sessionCode: string;
  workspaceCode?: string;
  content: string;
  attachments?: unknown[];
  /** Server-owned model selection; omit only for nodes without a catalog. */
  modelSelection?: ModelSelection | null;
  reasoningEffort?: ReasoningEffort | null;
  onDelta?: (delta: string) => void;
  /** Every AG-UI event of the run, including tool and reasoning events. */
  onEvent?: (event: AgUiEvent) => void;
}

/**
 * `session.sendMessage` — starts a run and streams AG-UI events back through the
 * tunnel. The `rpc_event.data` payload is already an AG-UI event, so the
 * existing event handling is reused as-is.
 */
export async function sendChatMessageStream(
  params: StreamChatParams,
): Promise<ChatSendResult> {
  if (params.signal?.aborted) {
    throw new ApiError(translate("请求已取消"), { code: "ABORTED" });
  }
  const rpc = new SessionRpc(params.tunnel);
  const stream = rpc.sendMessage(
    {
      sessionId: params.sessionCode,
      content: params.content,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      clientCapabilities: { userInputRequests: true },
      // The node requires an explicit selection to run its auto-model router;
      // without it the run starts against a placeholder route with no budget.
      ...(params.modelSelection
        ? { modelSelection: params.modelSelection as unknown as Record<string, unknown> }
        : {}),
      ...(params.reasoningEffort
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
      metadata: {
        workspaceCode: params.workspaceCode ?? null,
        assistantCode: params.assistantCode ?? null,
      },
    },
    { signal: params.signal, timeoutMs: 180_000 },
  );

  let result: ChatSendResult = { messages: [] };
  try {
    for await (const event of stream.events) {
      params.onEvent?.(event);
      const delta = aguiTextDelta(event);
      if (delta !== null) {
        params.onDelta?.(delta);
        continue;
      }
      const runError = aguiRunError(event);
      if (runError) {
        stream.cancel();
        throw new ApiError(runError.message, { code: runError.code });
      }
      if (isRunFinished(event)) {
        const finished = event as AgUiEvent & { result?: unknown };
        result = normalizeChatSendResult(finished.result, params.sessionCode);
      }
    }
  } finally {
    // The result promise settles with the run id; it is not needed here because
    // the chat screen reloads history after RUN_FINISHED.
    void stream.runId.catch(() => undefined);
  }
  return result;
}

/** Exposed for the generic session RPC (`session.list`) consumers. */
export function sessionRpcFor(tunnel: SecureTunnel): SessionRpc {
  return new SessionRpc(tunnel);
}

export interface WatchChatEventsParams {
  /** Business calls only need the tunnel; the generic method scopes by session. */
  tunnel: SecureTunnel;
  sessionCode: string;
  signal?: AbortSignal;
  /**
   * `tailOnly` asks the node for events recorded after the subscription opened
   * and skips the retained replay. The screen already reads the filtered replay
   * through `tron.chat.protocolEvents`, and the unfiltered one is capped at
   * several megabytes on a long session: replaying it twice over the tunnel
   * would delay the live tail it exists to deliver.
   */
  tailOnly?: boolean;
  /** One AG-UI event of this session, live. */
  onEvent?: (event: AgUiEvent) => void;
}

/**
 * `session.watchEvents` — the session's AG-UI event source, until the caller
 * aborts. A chat screen uses it to follow a run it did not start itself, so
 * re-opening a running session keeps updating instead of freezing on the last
 * persisted message.
 */
export async function watchChatEvents(
  params: WatchChatEventsParams,
): Promise<void> {
  if (params.signal?.aborted) return;
  const rpc = new SessionRpc(params.tunnel);
  const stream = rpc.watchEvents(
    {
      sessionId: params.sessionCode,
      // Sequences grow monotonically, so the largest safe integer is a cursor
      // nothing in the retained replay can be newer than.
      ...(params.tailOnly ? { cursor: Number.MAX_SAFE_INTEGER } : {}),
    },
    { signal: params.signal },
  );
  // `rpc_result` carries the subscription id and only settles when the
  // subscription ends; cancelling the stream is what releases it here.
  void stream.subscriptionId.catch(() => undefined);
  try {
    for await (const event of stream.events) {
      if (params.signal?.aborted) break;
      params.onEvent?.(event);
    }
  } finally {
    stream.cancel();
  }
}
