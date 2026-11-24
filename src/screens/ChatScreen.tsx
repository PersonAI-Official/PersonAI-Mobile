import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import {
  ASSISTANT_SOURCE_TYPE,
  createChatSession,
  defaultModelOption,
  listAssistants,
  listChatMessages,
  answerChatUserInput,
  getChatA2uiState,
  listChatProtocolEvents,
  listChatUserInputRequests,
  listDirectories,
  listModelSelectOptions,
  listWorkspaceOptions,
  runChatA2uiAction,
  sendChatMessageStream,
  setChatWorkingDirectory,
  steerChatMessage,
  stopChatRun,
  uploadChatAttachment,
  watchChatEvents,
  type ChatAttachment,
  type ChatMessage,
  type ChatSession,
  type DirectoryRecord,
  type ModelSelectOption,
  type ReasoningEffort,
} from "../api/tron";
import {
  SESSION_RPC_METHODS,
  supportsMethod,
  type AgUiEvent,
} from "../api/rpc";
import { AppHeader } from "../components/AppHeader";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { InlineBanner } from "../components/InlineBanner";
import { LoadingView } from "../components/LoadingView";
import { MessageBubble as LocalMessageBubble } from "../components/MessageBubble";
import {
  ModelEffortSelector,
  type ModelEffortSelectorLabels,
} from "../components/ModelEffortSelector";
import {
  WorkspaceSelector,
  type WorkspaceSelectorLabels,
} from "../components/WorkspaceSelector";
import { NodeLatencyText } from "../components/NodeLatency";
import { RunNotice, type RunNoticeLabels } from "../components/RunNotice";
import { RunProcess } from "../components/RunProcess";
import {
  ApprovalCard,
  Composer,
  MessageBubble as AgentMessageBubble,
  type ComposerAttachment,
  type ComposerClipboardFile,
} from "@personai/agent-ui-chat-react-native";
import {
  ChatA2uiSession,
  activeChatReplayPendingTurnMaxAgeMs,
  batchApprovalDecisions,
  buildAguiRunNotices,
  interactionMessages,
  mergeChatMessagesChronologically,
  nativeUserInputBatchAnswer,
  nativeUserInputRequests,
  openAguiProtocolRunCodes,
  pendingApprovalRequests,
  type AguiRunNotice,
  type ChatA2uiActionHandler,
  type ChatA2uiState,
  type ChatMessage as AgentChatMessage,
  type ChatUserInputAnswer,
  type ChatUserInputLabels,
  type ChatUserInputRequest,
  type TranscriptAguiEvent,
} from "@personai/agent-ui-chat-core/headless";
import { Screen } from "../components/Screen";
import { Ionicons } from "../components/icons";
import { translate, useI18n } from "../i18n";
import type { RootStackParamList } from "../navigation/types";
import { useNodeSession } from "../store/nodeSession";
import {
  layout,
  radius,
  spacing,
  typography,
  useTheme,
  useThemedStyles,
  type Palette,
} from "../theme";
import { describeError, isAbortError } from "../utils/format";
import { useKeyboardOverlap } from "../utils/keyboard";
import {
  buildRunTraces,
  reduceRunTrace,
  type RunTrace,
} from "../utils/runTrace";

type Props = NativeStackScreenProps<RootStackParamList, "Chat">;

interface QueuedChatMessage {
  id: string;
  content: string;
}

/** One run's lifecycle notices, derived from its AG-UI events. */
interface RunNotices {
  runId: string;
  notices: AguiRunNotice[];
}

/**
 * Per-session model choice, kept in memory only: chat preferences are session
 * content and never go to AsyncStorage. Matching the desktop composer, the
 * node's auto route is the fallback.
 */
/** Workspace display names per node, memory-only. */
const workspaceLabels = new Map<string, string>();

const sessionModelChoices = new Map<
  string,
  { optionCode: string; effort: ReasoningEffort | null }
>();

function eventRunId(event: AgUiEvent): string | null {
  return typeof event.runId === "string" && event.runId.trim()
    ? event.runId
    : null;
}

/**
 * The run this screen is following without having started it. `startedAt` keeps
 * the identity stable across re-reads while the node reports the same run, and
 * `trace` seeds the live work rail from what the replay already knows.
 */
interface OpenRun {
  runId: string;
  startedAt: number;
  trace: RunTrace | null;
}

/** `CUSTOM` event name that carries A2UI surface updates. */
const A2UI_EVENT_NAME = "agent.a2ui";

/** The stream event shape `ChatA2uiSession.applyEvent` accepts. */
type AguiStreamEventForA2ui = Parameters<ChatA2uiSession["applyEvent"]>[0];

function isTerminalRunEvent(event: AgUiEvent): boolean {
  const type = (event.type ?? "").toUpperCase();
  return type === "RUN_FINISHED" || type === "RUN_ERROR";
}

/**
 * The run the node is still working on, from its protocol replay.
 *
 * `openAguiProtocolRunCodes` reports every run without a terminal event, which
 * also includes runs whose client died mid-flight; the newest one inside the
 * pending-turn window is the only one worth following.
 */
function findOpenRun(
  events: AgUiEvent[],
  runOrder: string[],
  traces: Map<string, RunTrace>,
  sessionCode: string,
): OpenRun | null {
  const openCodes = openAguiProtocolRunCodes(
    events as unknown as TranscriptAguiEvent[],
    sessionCode,
  );
  if (!openCodes.size) return null;
  for (let index = runOrder.length - 1; index >= 0; index -= 1) {
    const runId = runOrder[index];
    if (!runId || !openCodes.has(runId)) continue;
    const trace = traces.get(runId) ?? null;
    const startedAt = trace?.startedAt ?? Date.now();
    if (Date.now() - startedAt > activeChatReplayPendingTurnMaxAgeMs) return null;
    return { runId, startedAt, trace };
  }
  return null;
}

/**
 * `session.watchEvents` is followed tail-only: the screen reads the filtered
 * protocol replay for history, so the subscription only has to report what
 * happens from now on. Durable re-reads are coalesced to one per beat because a
 * busy run streams events far faster than the transcript needs to repaint.
 */
const RESUME_REFRESH_MIN_MS = 1_200;
/** Re-read cadence while the event subscription is healthy. */
const RESUME_KEEPALIVE_MS = 10_000;
/** Re-read cadence when the node offers no usable subscription. */
const RESUME_POLL_MS = 2_500;

function toAgentMessage(
  message: ChatMessage,
  sessionCode: string,
  assistantName: string | null,
): AgentChatMessage {
  const createdAt =
    typeof message.createdAt === "string"
      ? message.createdAt
      : new Date(message.createdAt).toISOString();
  const isUser = message.role === "USER";
  return {
    id: message.id,
    messageId: message.messageCode ?? String(message.id),
    sessionId: sessionCode,
    role: isUser ? "USER" : "ASSISTANT",
    channel: message.channel ?? "MAIN_AGENT",
    actor: isUser
      ? (message.actor ?? "user")
      : assistantName?.trim() || message.actor || "assistant",
    content: message.content,
    createdAt,
    runId: message.runCode ?? null,
    ...(message.a2ui ? { a2ui: message.a2ui } : {}),
  };
}

function fileNameFromUri(uri: string): string {
  const clean = uri.split(/[?#]/)[0] ?? "";
  const name = clean.split("/").filter(Boolean).pop();
  return name && name.includes(".") ? decodeURIComponent(name) : `pasted-file-${Date.now()}`;
}

function mimeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(extension)) {
    return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  }
  if (extension === "pdf") return "application/pdf";
  if (["txt", "md", "json", "csv"].includes(extension)) {
    return extension === "md" ? "text/markdown" : `text/${extension}`;
  }
  return "application/octet-stream";
}

function stripDataUri(data: string): string {
  const index = data.indexOf(",");
  return data.startsWith("data:") && index >= 0 ? data.slice(index + 1) : data;
}

async function fileBase64(value: string | null | undefined): Promise<string> {
  if (!value) throw new Error(translate("剪贴板里没有可读取的文件"));
  // ImageManipulator and clipboard adapters may hand back raw base64 instead
  // of a URI; do not send that through the file-system reader.
  if (!/^(file|content|https?|data):/i.test(value)) return stripDataUri(value);
  const uri = value;
  if (uri.startsWith("data:")) return stripDataUri(uri);
  if (/^https?:/i.test(uri)) {
    const target = `${FileSystem.cacheDirectory ?? ""}pasted-${Date.now()}`;
    const downloaded = await FileSystem.downloadAsync(uri, target);
    return FileSystem.readAsStringAsync(downloaded.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
  return FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/** Survives the ChatScreen remount that follows the document-picker activity. */
let pendingUploadFile: { id: string; file: ComposerClipboardFile } | null = null;

const MAX_IMAGE_EDGE = 1280;
const IMAGE_QUALITY = 0.75;

/**
 * Pasted/picked photos are normalized before upload: downscale large images to
 * `MAX_IMAGE_EDGE` and re-encode as JPEG. Non-images and failures fall back to
 * the original file.
 */
async function prepareImageFile(
  file: ComposerClipboardFile,
): Promise<ComposerClipboardFile> {
  const mimeType = file.mimeType?.trim() || mimeFromName(file.name);
  if (!mimeType.startsWith("image/")) return file;
  try {
    let source = file.uri ?? undefined;
    if (!source || source.startsWith("data:")) {
      const base64 = stripDataUri(file.base64 ?? source ?? "");
      if (!base64) return file;
      const extension = mimeType.split("/")[1] || "png";
      source = `${FileSystem.cacheDirectory ?? ""}pasted-source-${Date.now()}.${extension}`;
      await FileSystem.writeAsStringAsync(source, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    const dimensions = await Promise.race([
      new Promise<{ width: number; height: number } | null>((resolve) => {
        Image.getSize(
          source!,
          (width, height) => resolve({ width, height }),
          () => resolve(null),
        );
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    const longest = dimensions
      ? Math.max(dimensions.width, dimensions.height)
      : 0;
    const actions =
      dimensions && longest > MAX_IMAGE_EDGE
        ? [
            dimensions.width >= dimensions.height
              ? { resize: { width: MAX_IMAGE_EDGE } }
              : { resize: { height: MAX_IMAGE_EDGE } },
          ]
        : [];
    const compressed = await Promise.race([
      ImageManipulator.manipulateAsync(source, actions, {
        base64: true,
        compress: IMAGE_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("image processing timed out")), 8000),
      ),
    ]);
    const base64 = compressed.base64;
    if (!base64) return file;
    const baseName = file.name.replace(/\.[^.]+$/, "") || `pasted-image-${Date.now()}`;
    return {
      name: `${baseName}.jpg`,
      mimeType: "image/jpeg",
      base64,
      uri: compressed.uri,
      size: Math.round(base64.length * 0.75),
    };
  } catch {
    return file;
  }
}

export function ChatScreen({ navigation, route }: Props) {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { t, format } = useI18n();
  const {
    status: sessionStatus,
    error: sessionError,
    contentEpoch,
    currentNode,
    methods,
    request: sessionRequest,
    reportRequestError,
    probeNow,
  } = useNodeSession();
  const { width } = useWindowDimensions();
  const wide = width >= layout.wideBreakpoint;
  const keyboardOverlap = useKeyboardOverlap();
  const agentTheme = {
    textColor: palette.text,
    mutedTextColor: palette.muted,
    surfaceColor: palette.surface,
    borderColor: palette.border,
    primaryColor: palette.accent,
    primaryTextColor: palette.onAccent,
    dangerColor: palette.danger,
    borderRadius: radius.card,
    spacing: spacing.md,
    panelColor: palette.background,
    userBubbleColor: palette.accent,
    userBubbleTextColor: palette.onAccent,
    assistantBubbleColor: palette.surface,
  };

  const { session, draft } = route.params;
  const sessionCode = session?.sessionCode ?? "";
  const draftCode = draft?.draftCode ?? "";
  /** Drafts are local navigation state until their first message is sent. */
  const isDraft = !session;
  /** Stable id for the conversation on screen; survives draft promotion. */
  const conversationKey = sessionCode || draftCode || "chat";
  /** Model choices belong to the draft/session the user is composing in. */
  const modelKey = sessionCode || draftCode;
  const workspaceCode =
    route.params.workspaceCode || session?.workspaceCode || draft?.workspaceCode || "";
  const effectiveAssistantCode =
    route.params.assistantCode ??
    ((session?.sourceType ?? "").toUpperCase() === ASSISTANT_SOURCE_TYPE
      ? (session?.sourceCode ?? null)
      : null);
  const [resolvedAssistantName, setResolvedAssistantName] = useState<
    string | null
  >(route.params.assistantName ?? null);
  const assistantName = resolvedAssistantName;
  const assistantChat = Boolean(effectiveAssistantCode);
  // Assistant sessions are titled with their assistant code on the node
  // (`main-dude · Interactive`); the name is what belongs in the header.
  const title = assistantChat
    ? assistantName?.trim() || t("个人助手")
    : session?.title?.trim() ||
      (assistantName
        ? format("与 {name} 的会话", { name: assistantName })
        : t("新会话"));
  const nodeLabel = currentNode?.name?.trim() || t("节点");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(() => Boolean(session));
  const [sending, setSending] = useState(false);
  /** True while the first message of a draft is creating its session. */
  const [creatingSession, setCreatingSession] = useState(false);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [traces, setTraces] = useState<Map<string, RunTrace>>(
    () => new Map(),
  );
  const [liveTrace, setLiveTrace] = useState<RunTrace | null>(null);
  /** Notices of the run being sent; cleared when the next turn starts. */
  const [liveRunNotices, setLiveRunNotices] = useState<RunNotices | null>(null);
  /** Per-run notices rebuilt from the node's protocol replay, in run order. */
  const [replayRunNotices, setReplayRunNotices] = useState<RunNotices[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedChatMessage[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [workspaceLabel, setWorkspaceLabel] = useState<string | null>(
    route.params.workspaceLabel ?? null,
  );
  const [workingDirectoryCode, setWorkingDirectoryCode] = useState<
    string | null
  >(
    session?.workingDirectoryCode ??
      session?.directoryCode ??
      draft?.directoryCode ??
      null,
  );
  const [workspaceDirectories, setWorkspaceDirectories] = useState<
    DirectoryRecord[]
  >([]);
  const [directoriesLoading, setDirectoriesLoading] = useState(false);
  const [directoriesFailed, setDirectoriesFailed] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelSelectOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelOptionCode, setModelOptionCode] = useState<string>(
    () => sessionModelChoices.get(modelKey)?.optionCode ?? "",
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(
    () => sessionModelChoices.get(modelKey)?.effort ?? null,
  );
  const [pendingRequests, setPendingRequests] = useState<ChatUserInputRequest[]>([]);
  const [answeredRequests, setAnsweredRequests] = useState<ChatUserInputRequest[]>([]);
  const [answering, setAnswering] = useState(false);
  const [a2uiRevision, setA2uiRevision] = useState(0);
  /**
   * A run the node is still working on. Re-opening a session whose protocol
   * replay has no terminal event must resume the live view instead of freezing
   * on the last persisted message.
   */
  const [openRun, setOpenRun] = useState<OpenRun | null>(null);
  /**
   * An answer or A2UI action was submitted, so the node is about to continue a
   * run this screen is not streaming itself. `runId` is the best-known id of that
   * run (empty until the resume actually announces one).
   *
   * `tron.chat.answerUserInput` and `tron.chat.a2uiAction` are one-shot calls that
   * internally collect the whole resumed run and answer only when it ends, so
   * without following the session stream the screen would sit with no progress
   * for the entire continuation - and lose it for good once the call deadline
   * passes.
   */
  const [adoptRun, setAdoptRun] = useState<{ runId: string | null } | null>(
    null,
  );
  /** Whether the node proved it took the submitted answer by resuming. */
  const answerResumedRef = useRef(false);
  /**
   * Why this screen is following a run: `replay` found one already working when
   * the session was opened, `submit` is the continuation of an answer or card
   * action this user just sent. Only the first may be ended by a replay that no
   * longer reports an open run - right after a submit the paused run still
   * carries its interrupt's terminal event, so the replay briefly says "no run".
   */
  const followSourceRef = useRef<"replay" | "submit">("submit");

  const listRef = useRef<FlatList<AgentChatMessage>>(null);
  const messagesSeqRef = useRef(0);
  const streamControllerRef = useRef<AbortController | null>(null);
  /** `session.watchEvents` of a run this screen did not start itself. */
  const resumeControllerRef = useRef<AbortController | null>(null);
  /** The run whose live view this screen is holding, if any. */
  const resumedRunIdRef = useRef<string | null>(null);
  /**
   * The tail of the followed run accumulated so far. A re-attach (new tunnel,
   * node switch) continues it instead of restarting the reply from nothing.
   */
  const resumeTailRef = useRef<{
    runId: string | null;
    text: string;
  } | null>(null);
  /** Lets the protocol re-read release a followed run it proves is over. */
  const settleResumedRunRef = useRef<() => void>(() => undefined);
  /** Coalesces the durable re-reads the resumed stream asks for. */
  const resumeRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const activeSessionRef = useRef(sessionCode);
  /** Latest real session code; promotion must be visible inside one async send. */
  const sessionCodeRef = useRef(sessionCode);
  /** Guards a second send before the draft's session exists. */
  const creatingSessionRef = useRef(false);
  /** Attachments staged locally until the draft's session exists. */
  const draftFilesRef = useRef(new Map<string, ComposerClipboardFile>());
  const sendingRef = useRef(false);
  const sessionStatusRef = useRef(sessionStatus);
  const liveTraceRef = useRef<RunTrace | null>(null);
  /** AG-UI events of the current send, the input of `buildAguiRunNotices`. */
  const runEventsRef = useRef<AgUiEvent[]>([]);
  /** What the message list was last reset for; status flips must not reset it. */
  const resetKeyRef = useRef<string>("");
  /** A draft becoming a session is not a conversation switch. */
  const promotedSessionRef = useRef(false);
  /** Bumped when the screen switches conversation, so a slow send can bail. */
  const conversationGenerationRef = useRef(0);
  /** Guards the one reload per online transition. */
  const onlineLoadedRef = useRef(false);
  /** Whether the current conversation has had its post-mount focus refresh. */
  const focusLoadedRef = useRef(false);
  const queuedRef = useRef<QueuedChatMessage[]>([]);
  const a2uiSession = useMemo(() => new ChatA2uiSession(sessionCode), [sessionCode]);
  const a2uiSessionRef = useRef(a2uiSession);
  const answeredRequestIdsRef = useRef(new Set<string>());
  const pendingRequestsRef = useRef<ChatUserInputRequest[]>([]);
  const a2uiBusyRef = useRef(false);
  /** Assistant name lookup for sessions opened without one (drawer, running). */
  const assistantLookupRef = useRef<string>("");
  const runMessageRef = useRef<
    (content: string, attachments?: ChatAttachment[]) => Promise<void>
  >(async () => undefined);

  const noticesByRun = useMemo(() => {
    const map = new Map<string, AguiRunNotice[]>();
    for (const entry of replayRunNotices) {
      if (entry.notices.length) map.set(entry.runId, entry.notices);
    }
    return map;
  }, [replayRunNotices]);
  /** Keeps the transcript pinned to the newest turn when it carries a notice. */
  const hasRunNotices =
    Boolean(liveRunNotices) ||
    replayRunNotices.some((entry) => entry.notices.length > 0);
  /**
   * The session is busy: this screen is streaming a run of its own, or the node
   * is still working on one it only follows. Both lock the composer and keep the
   * live work rail on screen.
   */
  const runActive = sending || Boolean(openRun) || Boolean(adoptRun);
  /**
   * The run whose live view this screen holds: one the node was already working
   * on when the session was opened, or the continuation a submitted answer or
   * A2UI action is about to start. The id is null for the second case until the
   * node announces it, because a resume may either reuse the paused run's id or
   * mint a new one. `trace` seeds the work rail from what the replay knows.
   */
  const followRunId = openRun?.runId ?? adoptRun?.runId ?? null;
  const followTrace = openRun?.trace ?? null;

  // A session opened from the dashboard carries no label; read it once per node
  // so the header always names the workspace the session lives in.
  useEffect(() => {
    if (workspaceLabel || !workspaceCode || sessionStatus !== "online") return;
    const key = `${currentNode?.id ?? ""}|${workspaceCode}`;
    const cached = workspaceLabels.get(key);
    if (cached) {
      setWorkspaceLabel(cached);
      return;
    }
    let cancelled = false;
    void sessionRequest(
      ({ tunnel }) => listWorkspaceOptions({ tunnel }),
      { retry: false },
    )
      .then((options) => {
        if (cancelled || !mountedRef.current) return;
        const match = options.find(
          (option) => option.workspaceCode === workspaceCode,
        );
        const label =
          match?.label?.trim() || match?.name?.trim() || null;
        if (label) {
          workspaceLabels.set(key, label);
          setWorkspaceLabel(label);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    currentNode?.id,
    sessionRequest,
    sessionStatus,
    workspaceCode,
    workspaceLabel,
  ]);

  const selectedModelOption = useMemo(
    () =>
      modelOptions.find((option) => option.optionCode === modelOptionCode) ??
      defaultModelOption(modelOptions),
    [modelOptionCode, modelOptions],
  );

  useEffect(() => {
    if (sessionStatus !== "online") return;
    let cancelled = false;
    setModelsLoading(true);
    void sessionRequest(
      ({ tunnel }) =>
        listModelSelectOptions({
          tunnel,
          workspaceCode,
          assistantCode: effectiveAssistantCode,
        }),
      { retry: false },
    )
      .then((options) => {
        if (cancelled || !mountedRef.current) return;
        setModelOptions(options);
        // Keep the remembered choice when the node still offers it; otherwise
        // fall back to the node's auto route, which is the desktop default.
        setModelOptionCode((current) =>
          options.some((option) => option.optionCode === current)
            ? current
            : (defaultModelOption(options)?.optionCode ?? ""),
        );
      })
      .catch(() => {
        // Older nodes do not expose the catalog; sending keeps its old shape.
        if (!cancelled && mountedRef.current) setModelOptions([]);
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    effectiveAssistantCode,
    sessionRequest,
    sessionStatus,
    workspaceCode,
  ]);

  // The effort belongs to the model: picking another model resets it to 自动.
  useEffect(() => {
    setReasoningEffort(sessionModelChoices.get(modelKey)?.effort ?? null);
  }, [modelKey]);

  useEffect(() => {
    if (!modelKey) return;
    sessionModelChoices.set(modelKey, {
      optionCode: modelOptionCode,
      effort: reasoningEffort,
    });
  }, [modelKey, modelOptionCode, reasoningEffort]);

  // Catalog refreshes can drop a level after it was remembered; never send it.
  useEffect(() => {
    if (reasoningEffort === null) return;
    const supported = selectedModelOption?.supportedReasoningEfforts ?? [];
    if (!supported.includes(reasoningEffort)) setReasoningEffort(null);
  }, [reasoningEffort, selectedModelOption]);

  const handleSelectModel = useCallback((option: ModelSelectOption) => {
    setModelOptionCode(option.optionCode);
    setReasoningEffort(null);
  }, []);

  useEffect(() => {
    const givenName = route.params.assistantName?.trim();
    if (givenName) {
      setResolvedAssistantName(givenName);
      return;
    }
    if (!effectiveAssistantCode) {
      setResolvedAssistantName(null);
      return;
    }
    if (sessionStatus !== "online") return;

    const key = `${effectiveAssistantCode}|${workspaceCode}`;
    if (assistantLookupRef.current === key) return;
    assistantLookupRef.current = key;
    let cancelled = false;
    void sessionRequest(({ tunnel }) =>
      listAssistants({ tunnel, workspaceCode }),
    )
      .then((assistants) => {
        if (cancelled) return;
        const match = assistants.find(
          (assistant) => assistant.assistantCode === effectiveAssistantCode,
        );
        setResolvedAssistantName(match?.name?.trim() || null);
      })
      .catch(() => {
        // Let the next online transition try again.
        if (assistantLookupRef.current === key) assistantLookupRef.current = "";
      });
    return () => {
      cancelled = true;
    };
  }, [
    effectiveAssistantCode,
    route.params.assistantName,
    sessionRequest,
    sessionStatus,
    workspaceCode,
  ]);

  useEffect(() => {
    queuedRef.current = queued;
  }, [queued]);

  useEffect(() => {
    liveTraceRef.current = liveTrace;
  }, [liveTrace]);

  useEffect(() => {
    pendingRequestsRef.current = pendingRequests;
  }, [pendingRequests]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    sessionCodeRef.current = sessionCode;
    activeSessionRef.current = sessionCode;
  }, [sessionCode]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamControllerRef.current?.abort();
    };
  }, []);

  const refreshProtocolEvents = useCallback(
    (sequence: number) => {
      const targetSessionCode = sessionCodeRef.current;
      if (!targetSessionCode || !workspaceCode || sessionStatus !== "online") {
        return;
      }
      void sessionRequest(
        ({ tunnel }) =>
          listChatProtocolEvents({
            tunnel,
            sessionCode: targetSessionCode,
            workspaceCode,
            assistantCode: effectiveAssistantCode,
          }),
        { retry: false },
      )
        .then((events) => {
          if (mountedRef.current && sequence === messagesSeqRef.current) {
            const terminal = events.some(
              (event) =>
                event.type === "RUN_FINISHED" || event.type === "RUN_ERROR",
            );
            const built = buildRunTraces(events);
            setTraces((previous) => {
              const next = new Map(built);
              // A run that just finished may not be in the node's replay yet;
              // keep the trace collected live instead of dropping it.
              for (const [runId, trace] of previous) {
                if (!next.has(runId)) next.set(runId, trace);
              }
              return next;
            });
            // Group the replay per run so the work rail can show the same
            // lifecycle notices the web clients derive from these events.
            const runOrder: string[] = [];
            const eventsByRun = new Map<string, AgUiEvent[]>();
            for (const event of events) {
              const runId = eventRunId(event);
              if (!runId) continue;
              const bucket = eventsByRun.get(runId);
              if (bucket) {
                bucket.push(event);
              } else {
                eventsByRun.set(runId, [event]);
                runOrder.push(runId);
              }
            }
            setReplayRunNotices(
              runOrder.map((runId) => ({
                runId,
                notices: buildAguiRunNotices(
                  (eventsByRun.get(runId) ?? []) as unknown as TranscriptAguiEvent[],
                ),
              })),
            );
            const requests = nativeUserInputRequests(
              events as Parameters<typeof nativeUserInputRequests>[0],
              targetSessionCode,
            ).filter(
              (request) => !answeredRequestIdsRef.current.has(request.requestId),
            );
            // A waiting run may not have a terminal replay event yet; keep the
            // requests loaded from the durable interaction history.
            if (terminal || requests.length) setPendingRequests(requests);
            // A run whose replay has no terminal event is still working on the
            // node. Track it so the screen keeps a live view of it instead of
            // stopping at the last persisted message. This client's own send
            // already streams the run, so it must not be watched twice.
            if (!streamControllerRef.current) {
              const open = findOpenRun(
                events,
                runOrder,
                built,
                targetSessionCode,
              );
              // The identity stays while the node reports the same open run, so a
              // re-read never restarts the follow effect.
              setOpenRun((previous) =>
                open && previous?.runId === open.runId ? previous : open,
              );
              if (
                !open &&
                resumedRunIdRef.current &&
                followSourceRef.current === "replay"
              ) {
                // Nothing delivered the terminal event (the node has no
                // subscription, or it dropped): the replay proves the run is
                // over, so the followed view has to be released here.
                settleResumedRunRef.current();
              }
            }
          }
        })
        .catch(() => undefined);
    },
    [effectiveAssistantCode, sessionCode, sessionRequest, sessionStatus, workspaceCode],
  );

  const refreshA2uiState = useCallback(async () => {
    const targetSessionCode = sessionCodeRef.current;
    if (!targetSessionCode || !workspaceCode || sessionStatus !== "online") {
      return;
    }
    try {
      const state = await sessionRequest(
        ({ tunnel }) =>
          getChatA2uiState({
            tunnel,
            sessionCode: targetSessionCode,
            workspaceCode,
            assistantCode: effectiveAssistantCode,
          }),
        { retry: false },
      );
      if (!state || !mountedRef.current) return;
      // Hydrating notifies the client, and the client subscription repaints the
      // rows that own those surfaces.
      a2uiSessionRef.current.hydrate(state as unknown as ChatA2uiState);
    } catch {
      // Older nodes do not expose A2UI state; display-only surfaces still work.
    }
  }, [
    effectiveAssistantCode,
    sessionCode,
    sessionRequest,
    sessionStatus,
    workspaceCode,
  ]);

  /**
   * Fold one AG-UI event into the live view. The stream of a message this screen
   * sent and the `session.watchEvents` tail of a run started elsewhere both feed
   * it, so the work rail, lifecycle notices, A2UI surfaces and ask-user cards
   * look the same whichever client started the run.
   */
  const observeLiveEvent = useCallback(
    (event: AgUiEvent) => {
      if (!mountedRef.current) return;
      const activeCode = sessionCodeRef.current;
      const type = (event.type ?? "").toUpperCase();
      // Only lifecycle/custom events feed the notice builder; text and tool
      // deltas would just grow the buffer for a long run.
      if (
        type === "RUN_STARTED" ||
        type === "RUN_FINISHED" ||
        type === "RUN_ERROR" ||
        type === "CUSTOM"
      ) {
        runEventsRef.current.push(event);
      }
      if (type === "RUN_STARTED") {
        setActiveRunId(eventRunId(event));
        setPendingRequests([]);
      } else if (type === "RUN_FINISHED") {
        setActiveRunId(null);
        const requests = nativeUserInputRequests(
          [event as Parameters<typeof nativeUserInputRequests>[0][number]],
          activeCode,
        ).filter(
          (request) => !answeredRequestIdsRef.current.has(request.requestId),
        );
        setPendingRequests(requests);
        void refreshA2uiState();
      } else if (type === "RUN_ERROR") {
        setActiveRunId(null);
        setPendingRequests([]);
      }
      // Same notice vocabulary as the web chat rail: a failed or stopped run is
      // reported from its AG-UI events, not invented per client. Recompute on
      // the run's terminal event.
      if (isTerminalRunEvent(event)) {
        const runId = eventRunId(event) ?? liveTraceRef.current?.runId ?? null;
        const notices = runId
          ? buildAguiRunNotices(
              runEventsRef.current as unknown as TranscriptAguiEvent[],
            )
          : [];
        if (runId && notices.length) {
          setLiveRunNotices({ runId, notices });
        }
      }
      // Surfaces travel as `CUSTOM agent.a2ui`. The runtime keeps its own
      // revision counter, so a rejected event means the stream missed one and
      // the canonical state has to be re-read.
      if (type === "CUSTOM" && event.name === A2UI_EVENT_NAME) {
        if (
          !a2uiSessionRef.current.applyEvent(
            event as unknown as AguiStreamEventForA2ui,
          )
        ) {
          void refreshA2uiState();
        }
      }
      const nextTrace = reduceRunTrace(liveTraceRef.current, event);
      if (nextTrace !== liveTraceRef.current) {
        liveTraceRef.current = nextTrace;
        setLiveTrace(nextTrace);
      }
    },
    [refreshA2uiState],
  );

  /** Re-read what the resumed run has produced so far (traces, surfaces). */
  const refreshResumedRun = useCallback(() => {
    if (!mountedRef.current) return;
    refreshProtocolEvents(messagesSeqRef.current);
    void refreshA2uiState();
  }, [refreshA2uiState, refreshProtocolEvents]);

  /**
   * Durable re-reads of the followed run, coalesced: a busy run streams events
   * far faster than the transcript needs to repaint, and each re-read asks the
   * node for its whole filtered replay.
   */
  const scheduleResumedRefresh = useCallback(
    (trailing: boolean) => {
      if (resumeRefreshRef.current) {
        if (!trailing) return;
        clearTimeout(resumeRefreshRef.current);
        resumeRefreshRef.current = null;
        refreshResumedRun();
        return;
      }
      const timer = setTimeout(() => {
        resumeRefreshRef.current = null;
        refreshResumedRun();
      }, RESUME_REFRESH_MIN_MS);
      resumeRefreshRef.current = timer;
    },
    [refreshResumedRun],
  );

  const readClipboardFile = useCallback(async (): Promise<ComposerClipboardFile | null> => {
    const image = await Clipboard.getImageAsync({ format: "png" });
    if (image?.data) {
      return {
        name: `pasted-image-${Date.now()}.png`,
        mimeType: "image/png",
        base64: image.data,
        uri: image.data,
      };
    }
    const url = (await Clipboard.getUrlAsync())?.trim();
    if (url && /^(file|content):/i.test(url)) {
      const name = fileNameFromUri(url);
      return { name, uri: url, mimeType: mimeFromName(name) };
    }
    const text = (await Clipboard.getStringAsync())?.trim();
    if (text && /^(file|content):\/\//i.test(text)) {
      const name = fileNameFromUri(text);
      return { name, uri: text, mimeType: mimeFromName(name) };
    }
    return null;
  }, []);

  const clipboardAdapter = useMemo(
    () => ({ readFile: readClipboardFile }),
    [readClipboardFile],
  );

  const uploadComposerFile = useCallback(
    async (
      file: ComposerClipboardFile,
      tempId?: string,
    ): Promise<ChatAttachment | null> => {
      // Read the ref, not the render value: a draft uploads right after the
      // first send created the session, before this callback is re-created.
      const targetSessionCode = sessionCodeRef.current;
      if (!targetSessionCode || !workspaceCode || sessionStatus !== "online") {
        setError(t("连接信息缺失或电脑离线，请返回重新连接节点"));
        return null;
      }
      setAttachmentUploading(true);
      try {
        const prepared = await prepareImageFile(file);
        const mimeType =
          prepared.mimeType?.trim() || mimeFromName(prepared.name);
        const dataBase64 = await fileBase64(
          prepared.base64 ?? prepared.uri,
        );
        const attachment = await sessionRequest(
          ({ tunnel }) =>
            uploadChatAttachment({
              tunnel,
              sessionCode: targetSessionCode,
              workspaceCode,
              assistantCode: effectiveAssistantCode,
              fileName:
                prepared.name || fileNameFromUri(prepared.uri ?? ""),
              contentType: mimeType,
              dataBase64,
              kind: mimeType.startsWith("image/") ? "image" : "file",
              summary: prepared.name,
            }),
          { retry: false },
        );
        if (!mountedRef.current) return attachment;
        setPendingAttachments((previous) =>
          tempId
            ? previous.map((item) => (item.id === tempId ? attachment : item))
            : [...previous, attachment],
        );
        const preview =
          prepared.uri &&
          (prepared.uri.startsWith("data:") || /^(file|content):/i.test(prepared.uri))
            ? prepared.uri
            : attachment.imageUrl ?? undefined;
        if (preview || tempId) {
          setAttachmentPreviews((previous) => {
            const next = { ...previous };
            if (tempId) delete next[tempId];
            if (preview) next[attachment.id] = preview;
            return next;
          });
        }
        return attachment;
      } catch (uploadError) {
        if (mountedRef.current && !isAbortError(uploadError)) {
          setError(describeError(uploadError));
        }
        // A staged draft file stays in the composer after a failed upload so
        // retrying the send retries that file instead of losing it.
        if (tempId && mountedRef.current && !draftFilesRef.current.has(tempId)) {
          setPendingAttachments((previous) =>
            previous.filter((item) => item.id !== tempId),
          );
          setAttachmentPreviews((previous) => {
            const next = { ...previous };
            delete next[tempId];
            return next;
          });
        }
        return null;
      } finally {
        if (mountedRef.current) setAttachmentUploading(false);
      }
    },
    [
      effectiveAssistantCode,
      sessionRequest,
      sessionStatus,
      t,
      workspaceCode,
    ],
  );

  const queueComposerFile = useCallback(
    (file: ComposerClipboardFile) => {
      const tempId = `local-attachment-${Date.now()}`;
      const mimeType = file.mimeType?.trim() || mimeFromName(file.name);
      const preview = file.base64
        ? `data:${mimeType};base64,${stripDataUri(file.base64)}`
        : file.uri ?? undefined;
      const local: ChatAttachment = {
        id: tempId,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        title: file.name,
        summary: file.name,
        imageUrl: preview ?? null,
        resourceCode: null,
        fileName: file.name,
        contentType: mimeType,
        byteSize: file.size ?? null,
        metadata: { uploading: true },
      };
      setPendingAttachments((previous) => [...previous, local]);
      if (preview) {
        setAttachmentPreviews((previous) => ({
          ...previous,
          [tempId]: preview,
        }));
      }
      // Drafts have no session to own an upload yet; stage the file locally and
      // upload it right after the first send creates the session.
      if (isDraft) {
        draftFilesRef.current.set(tempId, file);
        return;
      }
      pendingUploadFile = { id: tempId, file };
      if (sessionStatus === "online") {
        pendingUploadFile = null;
        void uploadComposerFile(file, tempId);
      } else {
        setNotice(t("正在重新连接，连接成功后会自动上传附件"));
      }
    },
    [isDraft, sessionStatus, t, uploadComposerFile],
  );

  useEffect(() => {
    if (sessionStatus !== "online") return;
    const queued = pendingUploadFile;
    if (!queued) return;
    pendingUploadFile = null;
    void uploadComposerFile(queued.file, queued.id);
  }, [sessionStatus, uploadComposerFile]);

  const pickAttachment = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    queueComposerFile({
      name: asset.name || fileNameFromUri(asset.uri),
      uri: asset.uri,
      mimeType: asset.mimeType || mimeFromName(asset.name || asset.uri),
      size: asset.size,
    });
  }, [queueComposerFile]);

  const loadMessages = useCallback(
    async (showSpinner: boolean) => {
      const targetSessionCode = sessionCodeRef.current;
      // A draft has no server session to read until its first message.
      if (!targetSessionCode || !workspaceCode || sessionStatus !== "online") {
        setLoading(false);
        return;
      }
      const sequence = ++messagesSeqRef.current;
      if (showSpinner) setLoading(true);
      try {
        const [next, requestHistory] = await Promise.all([
          sessionRequest(({ tunnel }) =>
            listChatMessages({
              tunnel,
              sessionCode: targetSessionCode,
              workspaceCode,
              assistantCode: effectiveAssistantCode,
            }),
          ),
          sessionRequest(
            ({ tunnel }) =>
              listChatUserInputRequests({
                tunnel,
                sessionCode: targetSessionCode,
                workspaceCode,
                assistantCode: effectiveAssistantCode,
              }),
            { retry: false },
          ).catch(() => [] as ChatUserInputRequest[]),
        ]);
        if (sequence !== messagesSeqRef.current) return;
        const answered = requestHistory.filter(
          (request) => request.status === "Answered",
        );
        answered.forEach((request) =>
          answeredRequestIdsRef.current.add(request.requestId),
        );
        setMessages(next);
        setAnsweredRequests(answered);
        setPendingRequests(
          requestHistory.filter(
            (request) =>
              request.status === "Pending" && request.questions.length > 0,
          ),
        );
        setError(null);
        refreshProtocolEvents(sequence);
        void refreshA2uiState();
      } catch (loadError) {
        if (sequence !== messagesSeqRef.current) return;
        if (!isAbortError(loadError)) setError(describeError(loadError));
      } finally {
        if (sequence === messagesSeqRef.current) setLoading(false);
      }
    },
    [
      effectiveAssistantCode,
      refreshA2uiState,
      refreshProtocolEvents,
      sessionCode,
      sessionRequest,
      sessionStatus,
      workspaceCode,
    ],
  );

  // Only a node switch, a background transition, or another session clears the
  // in-memory list. A connectivity flip (online -> reconnecting -> online) must
  // never wipe what is already on screen.
  useEffect(() => {
    // A draft keeps its identity on `draftCode`; promoting it to a real session
    // must not wipe the transcript, input, or attachments on screen.
    const resetKey = `${contentEpoch}|${conversationKey}`;
    if (resetKeyRef.current === resetKey) return;
    if (promotedSessionRef.current) {
      promotedSessionRef.current = false;
      resetKeyRef.current = resetKey;
      return;
    }
    resetKeyRef.current = resetKey;
    conversationGenerationRef.current += 1;
    onlineLoadedRef.current = false;
    focusLoadedRef.current = false;
    streamControllerRef.current?.abort();
    streamControllerRef.current = null;
    // The followed run belongs to the conversation being left; its subscription
    // and any re-read timer must not leak into the next one.
    resumeControllerRef.current?.abort();
    resumeControllerRef.current = null;
    resumedRunIdRef.current = null;
    resumeTailRef.current = null;
    answerResumedRef.current = false;
    settleResumedRunRef.current = () => undefined;
    setAdoptRun(null);
    if (resumeRefreshRef.current) {
      clearTimeout(resumeRefreshRef.current);
      resumeRefreshRef.current = null;
    }
    setOpenRun(null);
    messagesSeqRef.current += 1;
    sendingRef.current = false;
    setSending(false);
    setCreatingSession(false);
    creatingSessionRef.current = false;
    setMessages([]);
    setInput("");
    setStreamText("");
    setError(null);
    setNotice(null);
    setTraces(new Map());
    setLiveTrace(null);
    liveTraceRef.current = null;
    runEventsRef.current = [];
    setLiveRunNotices(null);
    setReplayRunNotices([]);
    setActiveRunId(null);
    queuedRef.current = [];
    setQueued([]);
    setPendingAttachments([]);
    setAttachmentPreviews({});
    draftFilesRef.current.clear();
    // The one-slot offline upload belongs to the conversation being left.
    pendingUploadFile = null;
    setPendingRequests([]);
    setAnsweredRequests([]);
    setAnswering(false);
    answeredRequestIdsRef.current = new Set();
    a2uiBusyRef.current = false;
    // Model choice belongs to the session (or draft) that recorded it.
    const remembered = sessionModelChoices.get(modelKey);
    setModelOptionCode(remembered?.optionCode ?? "");
    setReasoningEffort(remembered?.effort ?? null);
    setWorkspaceLabel(route.params.workspaceLabel ?? null);
    setWorkingDirectoryCode(
      route.params.session?.workingDirectoryCode ??
        route.params.session?.directoryCode ??
        route.params.draft?.directoryCode ??
        null,
    );
    setWorkspaceDirectories([]);
    setDirectoriesFailed(false);
    setA2uiRevision((value) => value + 1);
    // A reset to another draft has no session; keep the refs truthful so an
    // in-flight first send of the previous draft can detect the switch.
    sessionCodeRef.current = route.params.session?.sessionCode ?? "";
    activeSessionRef.current = sessionCodeRef.current;
    // A draft has nothing to load until its first message creates the session.
    setLoading(Boolean(sessionCodeRef.current) && sessionStatus !== "offline");
  }, [
    contentEpoch,
    conversationKey,
    modelKey,
    route.params.draft?.directoryCode,
    route.params.workspaceLabel,
    sessionStatus,
  ]);

  useEffect(() => {
    a2uiSessionRef.current = a2uiSession;
  }, [a2uiSession]);

  // Surfaces reach the runtime from the canonical read and from `agent.a2ui`
  // events; every change has to re-derive the transcript rows they own, or a new
  // card would only show up after the next unrelated repaint.
  useEffect(
    () =>
      a2uiSession.client.subscribe(() =>
        setA2uiRevision((value) => value + 1),
      ),
    [a2uiSession],
  );

  // Reconnects reload the transcript in place instead of clearing it.
  useEffect(() => {
    if (sessionStatus !== "online") {
      onlineLoadedRef.current = false;
      return;
    }
    if (onlineLoadedRef.current) return;
    onlineLoadedRef.current = true;
    void loadMessages(true);
  }, [loadMessages, sessionStatus]);

  // A screen the navigator kept mounted has to catch up when it comes back: the
  // node may have finished a turn, published a surface, or started a run while
  // another page had focus.
  useFocusEffect(
    useCallback(() => {
      if (
        !sessionCodeRef.current ||
        sessionStatusRef.current !== "online" ||
        streamControllerRef.current
      ) {
        return;
      }
      if (!focusLoadedRef.current) {
        focusLoadedRef.current = true;
        return;
      }
      void loadMessages(false);
    }, [loadMessages]),
  );

  const reloadMessages = useCallback(
    async (options: { clearError?: boolean } = {}): Promise<ChatMessage[] | null> => {
      const targetSessionCode = sessionCodeRef.current;
      if (!targetSessionCode || !workspaceCode || sessionStatus !== "online") {
        return null;
      }
      const sequence = ++messagesSeqRef.current;
      try {
        const next = await sessionRequest(({ tunnel }) =>
          listChatMessages({
            tunnel,
            sessionCode: targetSessionCode,
            workspaceCode,
            assistantCode: effectiveAssistantCode,
          }),
        );
        if (mountedRef.current && sequence === messagesSeqRef.current) {
          setMessages(next);
          // A failed send reloads the transcript to drop its optimistic row;
          // that reload must not also erase the failure the user has to see.
          if (options.clearError !== false) setError(null);
          refreshProtocolEvents(sequence);
        }
        return next;
      } catch {
        // Keep the visible error from the failed send.
        return null;
      }
    },
    [
    effectiveAssistantCode,
    refreshProtocolEvents,
    sessionCode,
    sessionRequest,
    sessionStatus,
    workspaceCode,
  ]);

  /**
   * Inputs this screen queued go next once the session is idle again, whether
   * the run ended on this screen's own stream or on one it only followed.
   */
  const drainQueuedInput = useCallback(() => {
    if (
      !mountedRef.current ||
      sendingRef.current ||
      sessionStatusRef.current !== "online" ||
      pendingRequestsRef.current.length
    ) {
      return;
    }
    const [next, ...rest] = queuedRef.current;
    if (!next) return;
    queuedRef.current = rest;
    setQueued(rest);
    setTimeout(() => void runMessageRef.current(next.content), 50);
  }, []);

  /** Drop the followed view and give the composer back to the user. */
  const releaseFollow = useCallback(() => {
    resumedRunIdRef.current = null;
    resumeTailRef.current = null;
    answerResumedRef.current = false;
    followSourceRef.current = "submit";
    sendingRef.current = false;
    setSending(false);
    setAdoptRun(null);
    setOpenRun(null);
    setAnswering(false);
    setActiveRunId(null);
    setStreamText("");
    setLiveTrace(null);
    liveTraceRef.current = null;
    runEventsRef.current = [];
  }, []);

  /**
   * The node finished a run this screen was only following: read the committed
   * reply back and hand the composer over.
   */
  const settleResumedRun = useCallback(() => {
    if (!mountedRef.current) return;
    releaseFollow();
    void reloadMessages();
    void refreshA2uiState();
    drainQueuedInput();
  }, [drainQueuedInput, refreshA2uiState, reloadMessages, releaseFollow]);

  /**
   * Release the followed view for the paths that already re-read the durable
   * views themselves: the answer and A2UI action calls return the resumed run's
   * events, so their completion means the node's run is over.
   */
  const settleFollow = useCallback(() => {
    if (!mountedRef.current) return;
    // A call that answers late must not tear down the view of a newer run this
    // screen started in the meantime.
    if (streamControllerRef.current) return;
    releaseFollow();
    drainQueuedInput();
  }, [drainQueuedInput, releaseFollow]);

  useEffect(() => {
    settleResumedRunRef.current = settleResumedRun;
  }, [settleResumedRun]);

  // A run the node is working on has to stay live: across a visit to another
  // page, and across the answer that resumes a paused one. This screen attaches
  // with `session.watchEvents` (tail only: the filtered replay it already reads
  // is the cheaper history) and keeps a slow re-read of the durable views as the
  // safety net, which is also what proves the run ended when no subscription
  // survived.
  useEffect(() => {
    const runId = followRunId;
    if (!runId && !adoptRun) return;
    if (!sessionCode || sessionStatus !== "online") return;
    // The session is busy for this screen: steer and queue are offered, a second
    // concurrent run is not.
    followSourceRef.current = openRun ? "replay" : "submit";
    resumedRunIdRef.current = runId;
    sendingRef.current = true;
    setSending(true);
    if (runId) setActiveRunId(runId);
    const tail =
      resumeTailRef.current && resumeTailRef.current.runId === runId
        ? resumeTailRef.current
        : { runId, text: "" };
    resumeTailRef.current = tail;
    setStreamText(tail.text);
    // Seed the rail with what the replay already knows; live events extend it.
    if (liveTraceRef.current?.runId !== runId) {
      liveTraceRef.current = runId ? followTrace : null;
      setLiveTrace(liveTraceRef.current);
    }
    runEventsRef.current = [];
    let stopped = false;
    let target = runId;
    let watchLive = false;
    let poll: ReturnType<typeof setTimeout> | null = null;
    let watch: AbortController | null = null;
    const stopPoll = () => {
      if (!poll) return;
      clearTimeout(poll);
      poll = null;
    };
    const reschedule = () => {
      stopPoll();
      poll = setTimeout(tick, watchLive ? RESUME_KEEPALIVE_MS : RESUME_POLL_MS);
    };
    function tick() {
      if (stopped) return;
      refreshResumedRun();
      reschedule();
    }
    const onEvent = (event: AgUiEvent) => {
      if (stopped) return;
      const type = (event.type ?? "").toUpperCase();
      const eventRun = eventRunId(event);
      // A resume announces its run with `RUN_STARTED`. This screen submitted the
      // answer, so the next run that starts here IS the continuation - it may
      // reuse the paused run's id or mint a new one, and the seed taken from the
      // request is only a guess until that event says otherwise.
      if (type === "RUN_STARTED" && eventRun && (!openRun || !target)) {
        target = eventRun;
        resumedRunIdRef.current = eventRun;
        tail.runId = eventRun;
        setActiveRunId(eventRun);
      }
      if (target && eventRun && eventRun !== target) return;
      // Rail, notices, ask-user cards and surfaces, with the same handling a run
      // started on this screen gets.
      observeLiveEvent(event);
      answerResumedRef.current = true;
      if (isTerminalRunEvent(event) && (!eventRun || eventRun === target)) {
        stopped = true;
        settleResumedRun();
        return;
      }
      // The tail is text this client has not seen yet: the committed reply
      // replaces it once the run finishes.
      if (type === "TEXT_MESSAGE_CONTENT" && eventRun === target) {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          tail.text += delta;
          setStreamText(tail.text);
        }
      }
    };
    const attach = () => {
      if (stopped) return;
      if (!supportsMethod(methods, SESSION_RPC_METHODS.watchEvents)) {
        // A product without an event bus may not implement the subscription at
        // all; the durable replay alone keeps this screen current.
        watchLive = false;
        reschedule();
        return;
      }
      const controller = new AbortController();
      watch = controller;
      resumeControllerRef.current = controller;
      const lost = () => {
        if (!watchLive || stopped) return;
        // The node closed the subscription, or it never worked: re-read now and
        // keep the transcript honest on the faster fallback cadence.
        watchLive = false;
        reschedule();
        scheduleResumedRefresh(true);
      };
      void sessionRequest(
        ({ tunnel }) =>
          watchChatEvents({
            tunnel,
            sessionCode,
            tailOnly: true,
            signal: controller.signal,
            onEvent,
          }),
        { retry: false },
      ).then(lost, lost);
    };
    watchLive = true;
    attach();
    reschedule();
    return () => {
      stopped = true;
      stopPoll();
      watch?.abort();
      if (watch && resumeControllerRef.current === watch) {
        resumeControllerRef.current = null;
      }
      if (resumeRefreshRef.current) {
        clearTimeout(resumeRefreshRef.current);
        resumeRefreshRef.current = null;
      }
    };
  }, [
    adoptRun,
    followRunId,
    followTrace,
    methods,
    openRun,
    observeLiveEvent,
    refreshResumedRun,
    scheduleResumedRefresh,
    sessionCode,
    sessionRequest,
    sessionStatus,
    settleResumedRun,
  ]);

  const scrollToBottom = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // Virtualized rows (especially markdown) can finish measuring after the last
  // content-size callback, which used to leave the transcript parked above the
  // newest turn. One short deferred scroll settles it on the real bottom.
  useEffect(() => {
    if (
      !messages.length &&
      !runActive &&
      !pendingRequests.length &&
      !hasRunNotices
    ) {
      return;
    }
    const timer = setTimeout(() => scrollToBottom(false), 120);
    return () => clearTimeout(timer);
  }, [
    hasRunNotices,
    messages,
    pendingRequests.length,
    runActive,
    scrollToBottom,
  ]);

  useEffect(() => {
    const subscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => {
        setTimeout(() => scrollToBottom(true), 120);
      },
    );
    return () => subscription.remove();
  }, [scrollToBottom]);

  const runMessage = useCallback(
    async (
      rawContent: string,
      attachments: ChatAttachment[] = [],
      targetSessionCode?: string,
    ) => {
      const content = rawContent.trim();
      // The first draft send passes the just-created session explicitly; the
      // ref covers callers that run before the promotion re-render.
      const activeCode = targetSessionCode ?? sessionCodeRef.current;
      if ((!content && !attachments.length) || sendingRef.current) return;
      if (!activeCode || !workspaceCode || sessionStatus !== "online") {
        setError(t("连接信息缺失或电脑离线，请返回重新连接节点"));
        return;
      }

      sendingRef.current = true;
      setSending(true);
      setError(null);
      setNotice(null);
      setStreamText("");
      setLiveTrace(null);
      liveTraceRef.current = null;
      runEventsRef.current = [];
      setLiveRunNotices(null);
      setActiveRunId(null);
      // This client now owns the run; the followed-run subscription would only
      // duplicate the stream it is already reading.
      setOpenRun(null);
      resumedRunIdRef.current = null;
      resumeTailRef.current = null;

      const optimisticId = `local-${Date.now()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        messageCode: optimisticId,
        sessionCode: activeCode,
        role: "USER",
        channel: "MAIN_AGENT",
        actor: "user",
        content,
        attachments,
        createdAt: new Date().toISOString(),
      };

      setMessages((previous) => [...previous, optimistic]);

      const controller = new AbortController();
      streamControllerRef.current = controller;
      let accumulated = "";

      // `session.sendMessage` streams AG-UI events through the tunnel. Text
      // deltas feed the streaming bubble; every other event feeds the run trace
      // so tool calls and reasoning stay visible while the agent works.
      try {
        const result = await sessionRequest(
          ({ tunnel }) =>
            sendChatMessageStream({
              tunnel,
              sessionCode: activeCode,
              workspaceCode,
              content,
              attachments,
              assistantCode: effectiveAssistantCode,
              // The node only runs its auto-model router when the request
              // carries an explicit selection; the desktop sends the same one.
              modelSelection: selectedModelOption?.modelSelection ?? null,
              reasoningEffort,
              signal: controller.signal,
              onDelta: (delta) => {
                accumulated += delta;
                if (mountedRef.current) setStreamText(accumulated);
              },
              onEvent: observeLiveEvent,
            }),
          { retry: false },
        );
        if (!mountedRef.current || activeSessionRef.current !== activeCode) {
          return;
        }

        // `result.messages` only contains this run's messages (the user turn
        // and the assistant reply), not the whole session. Reload the list so
        // earlier history is preserved and server message codes replace the
        // optimistic row.
        const reloaded = await reloadMessages();
        const hasReply = (list: ChatMessage[] | null | undefined): boolean =>
          Boolean(
            list?.some(
              (message) =>
                message.role === "ASSISTANT" &&
                message.content.trim().length > 0,
            ),
          );
        if (!hasReply(reloaded)) {
          // The node commits the reply before `RUN_FINISHED`, but the reload can
          // still race it — or fail. Fall back to the run result, then to the
          // streamed text, so a finished turn never renders as nothing.
          const carriedReply = result.messages.filter(
            (message) =>
              message.role === "ASSISTANT" &&
              message.content.trim().length > 0,
          );
          if (carriedReply.length) {
            setMessages((previous) => {
              const known = new Set(previous.map((item) => String(item.id)));
              return [
                ...previous,
                ...carriedReply.filter((item) => !known.has(String(item.id))),
              ];
            });
          } else if (accumulated.trim()) {
            const syntheticId = `stream-${Date.now()}`;
            const synthetic: ChatMessage = {
              id: syntheticId,
              messageCode: syntheticId,
              sessionCode: activeCode,
              role: "ASSISTANT",
              channel: "MAIN_AGENT",
              actor: "assistant",
              content: accumulated,
              attachments: [],
              createdAt: new Date().toISOString(),
            };
            setMessages((previous) => [...previous, synthetic]);
          }
        }

        // Protocol replay may be unavailable on older nodes; keep the trace we
        // collected live so the process view does not disappear.
        const finishedTrace = liveTraceRef.current as RunTrace | null;
        if (finishedTrace && finishedTrace.status !== "running") {
          setTraces((previous) =>
            new Map(previous).set(finishedTrace.runId, finishedTrace),
          );
        }
      } catch (sendError) {
        if (!mountedRef.current || activeSessionRef.current !== activeCode) {
          return;
        }

        if (isAbortError(sendError)) {
          setStreamText("");
          return;
        }

        reportRequestError(sendError);
        // `liveTraceRef.current` is assigned from the event callback, which the
        // compiler does not model; read it through an assertion so the trace the
        // run just produced is not narrowed away.
        const failedTrace = liveTraceRef.current as RunTrace | null;
        if (failedTrace && failedTrace.status === "failed") {
          // The node answered `RUN_ERROR`: the run notice built in `onEvent`
          // carries the failure, so keep the process view instead of adding a
          // second, generic banner the follow-up reload would clear.
          setTraces((previous) =>
            new Map(previous).set(failedTrace.runId, failedTrace),
          );
        } else {
          setError(describeError(sendError));
        }
        // Drop the optimistic row, but never clear the failure just reported.
        await reloadMessages({ clearError: false });
      } finally {
        if (streamControllerRef.current === controller) {
          streamControllerRef.current = null;
        }
        sendingRef.current = false;
        if (mountedRef.current) {
          setSending(false);
          setStreamText("");
        }
        if (!controller.signal.aborted) drainQueuedInput();
      }
    },
    [
      drainQueuedInput,
      effectiveAssistantCode,
      observeLiveEvent,
      reasoningEffort,
      reloadMessages,
      reportRequestError,
      selectedModelOption,
      sessionRequest,
      sessionStatus,
      t,
      workspaceCode,
    ],
  );

  useEffect(() => {
    runMessageRef.current = runMessage;
  }, [runMessage]);

  /**
   * Creates the real session behind a draft. Only the first message calls this,
   * so an abandoned draft never reaches the node, matching Tron's behavior.
   */
  const ensureDraftSession = useCallback(
    async (generation: number): Promise<ChatSession | null> => {
      const existing = route.params.session;
      if (existing) return existing;
      const activeDraft = route.params.draft;
      if (!activeDraft) return null;
      const targetWorkspaceCode = activeDraft.workspaceCode || workspaceCode;
      const created = await sessionRequest(({ tunnel }) =>
        createChatSession({
          tunnel,
          workspaceCode: targetWorkspaceCode,
          ...(activeDraft.projectCode
            ? { projectCode: activeDraft.projectCode }
            : {}),
          ...(activeDraft.directoryCode
            ? { directoryCode: activeDraft.directoryCode }
            : {}),
          ...(workingDirectoryCode ? { workingDirectoryCode } : {}),
        }),
      );

      // The user may have switched conversations while `session.create` was in
      // flight; never promote the screen that is now showing another chat.
      if (
        !mountedRef.current ||
        conversationGenerationRef.current !== generation
      ) {
        return null;
      }

      // The composer already lets the user pick a model for the first turn;
      // keep that choice on the real session instead of resetting it.
      if (modelOptionCode || reasoningEffort) {
        sessionModelChoices.set(created.sessionCode, {
          optionCode: modelOptionCode,
          effort: reasoningEffort,
        });
      }
      sessionModelChoices.delete(activeDraft.draftCode);
      sessionCodeRef.current = created.sessionCode;
      activeSessionRef.current = created.sessionCode;
      promotedSessionRef.current = true;
      // Replace the draft params with the real session so the header, refresh,
      // and any later navigation behave like an ordinary opened session.
      if (mountedRef.current) {
        navigation.setParams({
          draft: undefined,
          session: created,
          workspaceCode: created.workspaceCode ?? targetWorkspaceCode,
        });
      }
      return created;
    },
    [
      modelOptionCode,
      navigation,
      reasoningEffort,
      route.params.draft,
      route.params.session,
      sessionRequest,
      workspaceCode,
      workingDirectoryCode,
    ],
  );

  const sendDraftMessage = useCallback(
    async (content: string, attachments: ChatAttachment[]) => {
      if (creatingSessionRef.current) return;
      creatingSessionRef.current = true;
      setCreatingSession(true);
      setError(null);
      const generation = conversationGenerationRef.current;
      try {
        const created = await ensureDraftSession(generation);
        if (
          !created ||
          !mountedRef.current ||
          generation !== conversationGenerationRef.current
        ) {
          return;
        }

        // Files chosen before the first send were staged locally because there
        // was no session to own them yet. Upload them now and send their real
        // attachment ids with the message.
        let finalAttachments = attachments;
        const staged = draftFilesRef.current;
        if (staged.size) {
          const stagedIds = new Set(staged.keys());
          finalAttachments = attachments.filter(
            (item) => !stagedIds.has(item.id),
          );
          for (const [tempId, file] of Array.from(staged.entries())) {
            const uploaded = await uploadComposerFile(file, tempId);
            // Keep the draft text and staged file so the user can retry.
            if (!uploaded) return;
            finalAttachments.push(uploaded);
            staged.delete(tempId);
          }
        }

        if (
          !mountedRef.current ||
          generation !== conversationGenerationRef.current
        ) {
          return;
        }
        setInput("");
        setPendingAttachments([]);
        setAttachmentPreviews({});
        await runMessage(content, finalAttachments, created.sessionCode);
      } catch (createError) {
        if (mountedRef.current && !isAbortError(createError)) {
          reportRequestError(createError);
          setError(describeError(createError));
        }
      } finally {
        creatingSessionRef.current = false;
        if (mountedRef.current) setCreatingSession(false);
      }
    },
    [
      ensureDraftSession,
      reportRequestError,
      runMessage,
      uploadComposerFile,
    ],
  );

  const handleSend = useCallback(() => {
    const content = input.trim();
    const attachments = pendingAttachments;
    if ((!content && !attachments.length) || sendingRef.current) return;
    if (pendingRequests.length > 0 || answering) {
      setNotice(t("请先完成上面的回答"));
      return;
    }
    if (!workspaceCode || sessionStatus !== "online") {
      setError(t("连接信息缺失或电脑离线，请返回重新连接节点"));
      return;
    }
    // A draft keeps its input and attachments until `session.create` succeeds.
    if (isDraft) {
      void sendDraftMessage(content, attachments);
      return;
    }
    setInput("");
    setPendingAttachments([]);
    setAttachmentPreviews({});
    void runMessage(content, attachments);
  }, [
    answering,
    input,
    isDraft,
    pendingAttachments,
    pendingRequests.length,
    runMessage,
    sendDraftMessage,
    sessionStatus,
    t,
    workspaceCode,
  ]);

  const handleSteer = useCallback(async () => {
    const content = input.trim();
    if (!content || !sendingRef.current) return;
    if (!activeRunId) {
      setError(t("正在等待运行开始，暂时无法引导"));
      return;
    }
    try {
      const message = await sessionRequest(
        ({ tunnel }) =>
          steerChatMessage({
            tunnel,
            sessionCode,
            runId: activeRunId,
            content,
            workspaceCode,
            assistantCode: effectiveAssistantCode,
          }),
        { retry: false },
      );
      if (!mountedRef.current) return;
      setInput("");
      setError(null);
      setNotice(t("已插入引导，当前执行会收到这条消息"));
      if (message) {
        setMessages((previous) => [...previous, message]);
      }
    } catch (steerError) {
      if (mountedRef.current) setError(describeError(steerError));
    }
  }, [
    activeRunId,
    effectiveAssistantCode,
    input,
    sessionCode,
    sessionRequest,
    t,
    workspaceCode,
  ]);

  const queueInput = useCallback(() => {
    const content = input.trim();
    if (!content || !sendingRef.current) return;
    const next = [
      ...queuedRef.current,
      { id: `queue-${Date.now()}`, content },
    ];
    queuedRef.current = next;
    setQueued(next);
    setInput("");
    setNotice(t("已加入队列，当前回复结束后自动发送"));
  }, [input, t]);

  const removeQueued = useCallback((id: string) => {
    const next = queuedRef.current.filter((item) => item.id !== id);
    queuedRef.current = next;
    setQueued(next);
  }, []);

  const reorderQueued = useCallback((sourceId: string, targetId: string) => {
    const current = queuedRef.current;
    const source = current.findIndex((item) => item.id === sourceId);
    const target = current.findIndex((item) => item.id === targetId);
    if (source < 0 || target < 0 || source === target) return;
    const next = current.slice();
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    queuedRef.current = next;
    setQueued(next);
  }, []);

  const handleStop = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await sessionRequest(
        ({ tunnel }) =>
          stopChatRun({
            tunnel,
            sessionCode,
            workspaceCode,
            runId: activeRunId,
            assistantCode: effectiveAssistantCode,
          }),
        { retry: false },
      );
      if (mountedRef.current) setNotice(t("已停止当前执行"));
    } catch (stopError) {
      if (mountedRef.current) setError(describeError(stopError));
    }
  }, [
    activeRunId,
    effectiveAssistantCode,
    sessionCode,
    sessionRequest,
    t,
    workspaceCode,
  ]);

  const applyInteractionEvents = useCallback(
    (events: AgUiEvent[]) => {
      if (!events.length) return;
      setTraces((previous) => {
        const next = new Map(previous);
        for (const [runId, trace] of buildRunTraces(events)) {
          next.set(runId, trace);
        }
        return next;
      });
      const requests = nativeUserInputRequests(
        events as Parameters<typeof nativeUserInputRequests>[0],
        sessionCode,
      ).filter(
        (request) => !answeredRequestIdsRef.current.has(request.requestId),
      );
      setPendingRequests(requests);
    },
    [sessionCode],
  );

  const handleAnswer = useCallback(
    async (request: ChatUserInputRequest, answers: ChatUserInputAnswer[]) => {
      if (!request || answering) return;
      const approval =
        request.nativeInteraction?.reason === "approval_required" ||
        (request.nativeInteraction?.responseSchema as { type?: string } | undefined)
          ?.type === "boolean";
      let requests = [request];
      let finalAnswers = answers;
      if (approval) {
        const selected = answers.find(
          (answer) =>
            answer.questionId === request.requestId &&
            answer.answerKind === "Option",
        );
        const payload = selected?.optionId
          ? request.nativeInteraction?.optionPayloads[selected.optionId]
          : undefined;
        const group = pendingApprovalRequests(request, pendingRequests);
        const decisions =
          typeof payload === "boolean"
            ? batchApprovalDecisions(group, payload)
            : null;
        if (decisions && group.length > 1) {
          requests = group;
          finalAnswers = Object.values(decisions).flat();
        }
      }
      let input;
      try {
        input = nativeUserInputBatchAnswer(requests, finalAnswers);
      } catch (answerError) {
        setError(describeError(answerError));
        return;
      }
      setAnswering(true);
      const answeredIds = new Set(requests.map((item) => item.requestId));
      answeredIds.forEach((id) => answeredRequestIdsRef.current.add(id));
      setPendingRequests((previous) =>
        previous.filter((item) => !answeredIds.has(item.requestId)),
      );
      // The answer call only returns when the resumed run ends, so the live view
      // has to come from the session stream instead: adopt the continuation now
      // and let its terminal event commit the transcript.
      answerResumedRef.current = false;
      setStreamText("");
      setLiveTrace(null);
      liveTraceRef.current = null;
      setAdoptRun({ runId: request.runId?.trim() || null });
      try {
        const events = await sessionRequest(
          ({ tunnel }) =>
            answerChatUserInput({
              tunnel,
              sessionCode,
              workspaceCode,
              assistantCode: effectiveAssistantCode,
              requestCode: request.requestId,
              answers: input.answers,
              resume: input.resume,
              a2uiMetadata: input.a2uiMetadata,
            }),
          { retry: false },
        );
        if (!mountedRef.current) return;
        applyInteractionEvents(events);
        setAnsweredRequests((previous) => [
          ...previous.filter((item) => !answeredIds.has(item.requestId)),
          ...requests.map((item) => ({
            ...item,
            status: "Answered" as const,
            answers: finalAnswers,
            answeredAt: Date.now(),
          })),
        ]);
        await reloadMessages();
        void refreshA2uiState();
        // The run ended with this call; the subscription needs no longer hold.
        settleFollow();
      } catch (answerError) {
        if (answerResumedRef.current || followSourceRef.current === "replay") {
          // The node took the answer and resumed; the one-shot call merely
          // stopped waiting. Restoring the card here would offer an answer that
          // is already spent, so re-read the durable views instead.
          await reloadMessages({ clearError: false });
          void refreshA2uiState();
          settleFollow();
        } else {
          answeredIds.forEach((id) =>
            answeredRequestIdsRef.current.delete(id),
          );
          setPendingRequests((previous) => [
            ...requests.filter(
              (item) =>
                !previous.some((entry) => entry.requestId === item.requestId),
            ),
            ...previous,
          ]);
          setAdoptRun(null);
          if (!isAbortError(answerError)) {
            reportRequestError(answerError);
            setError(describeError(answerError));
          }
        }
      } finally {
        if (mountedRef.current) setAnswering(false);
      }
    },
    [
      answering,
      applyInteractionEvents,
      effectiveAssistantCode,
      pendingRequests,
      refreshA2uiState,
      reloadMessages,
      reportRequestError,
      sessionCode,
      sessionRequest,
      settleFollow,
      workspaceCode,
    ],
  );

  const handleA2UIAction = useCallback<ChatA2uiActionHandler>(
    (message, metadata, context) => {
      const surface = context?.surface;
      if (!surface || a2uiBusyRef.current) return;
      a2uiBusyRef.current = true;
      const actionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Like the ask-user answer, this call only returns when the run the action
      // resumed is over: follow the session stream so the card shows progress and
      // commits itself instead of waiting on this call.
      answerResumedRef.current = false;
      setStreamText("");
      setLiveTrace(null);
      liveTraceRef.current = null;
      setAdoptRun({ runId: surface.runId?.trim() || null });
      void (async () => {
        try {
          const events = await sessionRequest(
            ({ tunnel }) =>
              runChatA2uiAction({
                tunnel,
                sessionCode,
                workspaceCode,
                assistantCode: effectiveAssistantCode,
                actionId,
                surfaceInstanceId: surface.surfaceInstanceId,
                expectedRevision: surface.revision,
                message,
                metadata,
              }),
            { retry: false },
          );
          if (!mountedRef.current) return;
          applyInteractionEvents(events);
          await reloadMessages();
          void refreshA2uiState();
          settleFollow();
        } catch (actionError) {
          if (answerResumedRef.current || followSourceRef.current === "replay") {
            await reloadMessages({ clearError: false });
            void refreshA2uiState();
            settleFollow();
          } else {
            setAdoptRun(null);
            if (!isAbortError(actionError)) {
              reportRequestError(actionError);
              setError(describeError(actionError));
            }
          }
        } finally {
          a2uiBusyRef.current = false;
        }
      })();
    },
    [
      applyInteractionEvents,
      effectiveAssistantCode,
      refreshA2uiState,
      reloadMessages,
      reportRequestError,
      sessionCode,
      sessionRequest,
      settleFollow,
      workspaceCode,
    ],
  );

  const userInputLabels = useMemo<ChatUserInputLabels>(
    () => ({
      ariaLabel: t("助手提问"),
      progress: (current, total) =>
        format("第 {current} / {total} 题", { current, total }),
      back: t("上一步"),
      next: t("下一步"),
      continue: t("继续"),
      confirm: t("确认"),
      continuing: t("继续中…"),
      otherOptionLabel: t("其他"),
      otherOptionDescription: t("输入自定义回答"),
      skipOptionLabel: t("跳过"),
      skipOptionDescription: t("跳过此问题"),
      otherAnswerPlaceholder: t("输入你的答案"),
      otherAnswerAriaLabel: (index) =>
        format("其他答案（第 {index} 题）", { index }),
      approve: t("批准"),
      reject: t("拒绝"),
      approved: t("已批准"),
      rejected: t("已拒绝"),
      approvalTitle: t("批准工具执行"),
      approvalExecution: t("执行"),
      approvalDirectory: t("工作目录"),
      approvalParameters: t("全部参数"),
      approvalReason: t("为什么需要批准"),
      approvalScope: t("仅对本次调用生效"),
      approvalMissingDetails: t("执行详情未提供"),
    }),
    [format, t],
  );

  const loadWorkspaceDirectories = useCallback(async () => {
    if (!workspaceCode || sessionStatus !== "online") return;
    setDirectoriesLoading(true);
    setDirectoriesFailed(false);
    try {
      const directories = await sessionRequest(
        ({ tunnel }) =>
          listDirectories({ tunnel, workspaceCode, assistantCode: effectiveAssistantCode }),
        { retry: false },
      );
      if (mountedRef.current) setWorkspaceDirectories(directories);
    } catch {
      if (mountedRef.current) setDirectoriesFailed(true);
    } finally {
      if (mountedRef.current) setDirectoriesLoading(false);
    }
  }, [
    effectiveAssistantCode,
    sessionRequest,
    sessionStatus,
    workspaceCode,
  ]);

  useEffect(() => {
    void loadWorkspaceDirectories();
  }, [loadWorkspaceDirectories]);

  const handleWorkingDirectoryChange = useCallback(
    async (directoryCode: string | null) => {
      // A draft has no session yet; keep the choice and pass it to
      // `session.create` with the first message.
      if (!sessionCodeRef.current) {
        setWorkingDirectoryCode(directoryCode);
        setError(null);
        return;
      }
      try {
        const updated = await sessionRequest(
          ({ tunnel }) =>
            setChatWorkingDirectory({
              tunnel,
              sessionCode: sessionCodeRef.current,
              workspaceCode,
              assistantCode: effectiveAssistantCode,
              directoryCode,
            }),
          { retry: false },
        );
        if (!mountedRef.current) return;
        setWorkingDirectoryCode(
          updated?.workingDirectoryCode ??
            updated?.directoryCode ??
            directoryCode,
        );
        setError(null);
      } catch (changeError) {
        if (mountedRef.current) setError(describeError(changeError));
      }
    },
    [
      effectiveAssistantCode,
      sessionCode,
      sessionRequest,
      workspaceCode,
    ],
  );

  const workspaceSelectorLabels = useMemo<WorkspaceSelectorLabels>(
    () => ({
      ariaLabel: t("选择工作区"),
      noDirectory: t("不指定工作区"),
      workspaceFallback: t("工作空间"),
      loading: t("正在读取工作区…"),
      loadFailed: t("工作区读取失败"),
      retry: t("重试"),
      unavailable: t("不可用"),
      close: t("关闭"),
      pickTitle: t("选择工作区"),
      empty: t("这个工作空间还没有目录。"),
      addHint: t("在电脑端设置里添加目录后，这里会显示可选的工作区。"),
    }),
    [t],
  );

  const modelSelectorLabels = useMemo<ModelEffortSelectorLabels>(
    () => ({
      triggerAria: (model, effort) =>
        effort
          ? format("选择模型：{model}，智力程度 {effort}", { model, effort })
          : format("选择模型：{model}", { model }),
      panelTitle: t("模型与智力程度"),
      effortLabel: t("智力程度"),
      automatic: t("自动"),
      faster: t("更快"),
      deeper: t("更深入"),
      currentModel: t("当前模型"),
      changeModel: t("更换模型"),
      hideModels: t("收起模型"),
      searchPlaceholder: t("搜索模型…"),
      noMatch: (query) => format("没有匹配“{query}”的模型。", { query }),
      autoName: t("对话自动路由"),
      providerModels: t("供应商模型"),
      qualityGroup: (quality, vendor) =>
        format("{quality} · {vendor}", { quality, vendor }),
      empty: t("没有可用模型"),
      loading: t("加载模型中…"),
      close: t("关闭"),
      effortNames: {
        None: t("关闭思考"),
        Minimal: t("极低"),
        Low: t("低"),
        Medium: t("中"),
        High: t("高"),
        XHigh: t("超高"),
        Max: t("最大"),
        Ultra: "Ultra",
      },
      qualityNames: {
        High: t("远程高质量"),
        Middle: t("远程中质量"),
        Low: t("远程低质量"),
      },
    }),
    [format, t],
  );

  const runNoticeLabels = useMemo<RunNoticeLabels>(
    () => ({
      failed: t("运行失败"),
      stopped: t("已停止"),
      mcpUnavailable: t("MCP 集成不可用"),
      presentationIncomplete: t("展示回放不完整"),
      presentationIncompleteDetail: t(
        "部分输出未能展示或保存，执行结果另行报告。",
      ),
      compactionRequested: t("准备压缩上下文…"),
      compactionStarted: t("正在压缩上下文…"),
      compactionCompleted: t("上下文已压缩"),
      compactionFailed: t("上下文压缩失败"),
      compactionInterrupted: t("运行结束时压缩尚未完成"),
      toolSchemaOverBudget: t("工具定义超出上下文预算"),
      toolSchemaBudget: (estimatedTokens, limitTokens, toolCount) =>
        format("工具定义约占 {actual} tokens，超过 {limit} 的上限（{count} 个工具）。", {
          actual: estimatedTokens.toLocaleString(),
          limit: limitTokens.toLocaleString(),
          count: toolCount.toLocaleString(),
        }),
      toolSchemaBudgetHint: t("减少暴露的工具，或提高工具 Schema 预算。"),
      details: t("错误详情"),
    }),
    [format, t],
  );

  const agentMessages = useMemo(
    () =>
      messages.map((message) =>
        toAgentMessage(message, sessionCode, assistantName),
      ),
    [assistantName, messages, sessionCode],
  );
  const transcriptMessages = useMemo(
    () =>
      interactionMessages(
        // A2UI surfaces are the session's own state, not a field the node
        // persists on a message row, so they have to be merged back in. Without
        // this a card only exists while the client that received it stays on
        // screen, and every reload drops it.
        mergeChatMessagesChronologically(
          agentMessages,
          a2uiSession.messages(),
        ),
        [...pendingRequests, ...answeredRequests],
        undefined,
        userInputLabels,
      ),
    [
      a2uiRevision,
      a2uiSession,
      agentMessages,
      answeredRequests,
      pendingRequests,
      userInputLabels,
    ],
  );

  const horizontalPadding = 20;
  const unauthorized = sessionStatus === "unauthorized";
  const offline = sessionStatus === "offline";
  const disconnected = offline || unauthorized;
  const canSend =
    (Boolean(input.trim()) || pendingAttachments.length > 0) &&
    !runActive &&
    !creatingSession &&
    !answering &&
    pendingRequests.length === 0 &&
    !loading &&
    sessionStatus === "online";
  const canSteer = Boolean(input.trim()) && runActive && Boolean(activeRunId);
  const canQueue = Boolean(input.trim()) && runActive;

  // A run can produce more than one assistant message (steer/resume). Render
  // its process above the final message only, instead of repeating the tools.
  // The run this screen is following is excluded: its rail belongs to the live
  // tail at the end of the transcript, where a surface published mid-run would
  // otherwise duplicate it.
  const traceOwnerByRun = useMemo(() => {
    const owners = new Map<string, string>();
    for (const message of transcriptMessages) {
      if (
        message.role === "ASSISTANT" &&
        message.runId &&
        message.runId !== followRunId
      ) {
        owners.set(message.runId, message.messageId);
      }
    }
    return owners;
  }, [followRunId, transcriptMessages]);

  // The work rail of the newest turn. A failed run usually has no assistant
  // message to own it (the node never persists one), so its notice belongs at
  // the end of the transcript; once an assistant row owns the run, that row
  // renders the notice instead.
  const newestReplay = replayRunNotices.length
    ? replayRunNotices[replayRunNotices.length - 1]
    : null;
  const pendingRunNotices =
    liveRunNotices ??
    (newestReplay && newestReplay.notices.length ? newestReplay : null);
  const footerRunNotices =
    pendingRunNotices && !traceOwnerByRun.has(pendingRunNotices.runId)
      ? pendingRunNotices
      : null;
  const footerRunTrace = footerRunNotices
    ? traces.get(footerRunNotices.runId) ?? null
    : null;
  /**
   * The rail of the busy run. A followed run is seeded from the node's replay and
   * extended by the subscription; whichever side knows more of the run's work
   * wins, so a gap between the two reads heals on the next one.
   */
  const resumedTrace = followRunId ? traces.get(followRunId) ?? null : null;
  const liveRunTrace = followRunId
    ? resumedTrace &&
      (!liveTrace ||
        liveTrace.runId !== followRunId ||
        resumedTrace.tools.length >= liveTrace.tools.length)
      ? resumedTrace
      : liveTrace
    : liveTrace;
  const liveRunRailNotices = followRunId
    ? noticesByRun.get(followRunId) ??
      (liveRunNotices?.runId === followRunId
        ? liveRunNotices.notices
        : undefined)
    : liveRunTrace && liveRunNotices?.runId === liveRunTrace.runId
      ? liveRunNotices.notices
      : undefined;

  return (
    <Screen padded={false}>
      <View style={[styles.flex, { paddingBottom: keyboardOverlap }]}>
        <View
          style={[styles.headerWrap, { paddingHorizontal: wide ? 32 : 20 }]}
        >
          <AppHeader
            title={title}
            titleAccessory={
              workspaceLabel ? (
                <View style={styles.workspaceTag}>
                  <Ionicons name="layers-outline" size={10} color={palette.accent} />
                  <Text style={styles.workspaceTagText} numberOfLines={1}>
                    {workspaceLabel}
                  </Text>
                </View>
              ) : null
            }
            subtitle={
              assistantChat
                ? nodeLabel
                : assistantName
                  ? `${t("个人助手")} · ${assistantName}`
                  : t("会话", "chat")
            }
            subtitleAccessory={
              assistantChat && currentNode ? (
                <NodeLatencyText
                  nodeId={currentNode.id}
                  leadingSeparator="·"
                  showPlaceholder
                />
              ) : null
            }
            onBack={() => navigation.goBack()}
            right={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("刷新消息")}
                accessibilityState={{
                  disabled: sending || loading || disconnected || isDraft,
                }}
                disabled={sending || loading || disconnected || isDraft}
                onPress={() => void loadMessages(true)}
                style={({ pressed }) => [
                  styles.headerIconButton,
                  (sending || loading || disconnected || isDraft) &&
                    styles.headerIconButtonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Ionicons name="refresh" size={18} color={palette.text} />
              </Pressable>
            }
          />
        </View>

        {disconnected ? (
          <View style={styles.offlineWrap}>
            <EmptyState
              icon={unauthorized ? "key-outline" : "cloud-offline-outline"}
              title={unauthorized ? t("凭证失效") : t("电脑离线")}
              message={
                sessionError ??
                (unauthorized
                  ? t(
                      "电脑端已吊销或删除了这台设备的配对凭证。请删除节点后重新扫码配对。",
                    )
                  : t(
                      "无法连接这台电脑，已清空当前会话内容。请确认电脑端 Tron 在运行，并检查网络与节点地址。",
                    ))
              }
              action={
                unauthorized ? (
                  <Button
                    label={t("返回看板")}
                    icon="grid-outline"
                    onPress={() => navigation.navigate("Dashboard")}
                  />
                ) : (
                  <Button
                    label={t("重新连接")}
                    icon="refresh"
                    onPress={() => void probeNow()}
                  />
                )
              }
            />
          </View>
        ) : (
          <View style={[styles.body, { paddingHorizontal: wide ? 32 : 0 }]}>
            <View style={styles.chatColumn}>
              {sessionStatus === "connecting" && sessionError ? (
                <View style={styles.bannerWrap}>
                  <InlineBanner
                    message={sessionError ?? t("正在重新连接电脑…")}
                    tone="info"
                  />
                </View>
              ) : null}
              {notice ? (
                <View style={styles.bannerWrap}>
                  <InlineBanner message={notice} tone="info" />
                </View>
              ) : null}
              {error ? (
                <View style={styles.bannerWrap}>
                  <InlineBanner
                    message={error}
                    actionLabel={isDraft ? undefined : t("重试")}
                    onAction={
                      isDraft ? undefined : () => void loadMessages(true)
                    }
                  />
                </View>
              ) : null}

              <FlatList
                ref={listRef}
                data={transcriptMessages}
                extraData={[
                  traces,
                  a2uiRevision,
                  pendingRequests,
                  answeredRequests,
                  noticesByRun,
                ]}
                keyExtractor={(item) => item.messageId}
                renderItem={({ item }) => {
                  const trace =
                    item.role === "ASSISTANT" &&
                    item.runId &&
                    traceOwnerByRun.get(item.runId) === item.messageId
                      ? traces.get(item.runId)
                      : undefined;
                  return (
                    <View>
                      {trace ? (
                        <RunProcess
                          trace={trace}
                          noticeLabels={runNoticeLabels}
                          notices={
                            item.runId ? noticesByRun.get(item.runId) : undefined
                          }
                        />
                      ) : null}
                      {item.role === "USER" &&
                      item.runId &&
                      !item.interactionResponse ? (
                        <View style={styles.steerBadge}>
                          <Ionicons
                            name="git-branch-outline"
                            size={12}
                            color={palette.muted}
                          />
                          <Text style={styles.steerBadgeText}>{t("引导")}</Text>
                        </View>
                      ) : null}
                      <AgentMessageBubble
                        message={item}
                        onA2UIAction={handleA2UIAction}
                        runtime={a2uiSession}
                        showIdentity={item.role === "ASSISTANT"}
                        theme={agentTheme}
                      />
                    </View>
                  );
                }}
                contentContainerStyle={[
                  styles.messagesContent,
                  { paddingHorizontal: horizontalPadding },
                  messages.length === 0 && !loading && styles.messagesContentEmpty,
                ]}
                ListEmptyComponent={
                  loading ? (
                    <LoadingView
                      label={
                        sessionStatus === "online"
                          ? t("正在加载消息…")
                          : t("正在建立安全会话…")
                      }
                    />
                  ) : (
                    <EmptyState
                      bare
                      icon="chatbubble-ellipses-outline"
                      title={t("开始对话")}
                      message={
                        assistantName
                          ? format("和 {name} 打个招呼，开始新的对话。", {
                              name: assistantName,
                            })
                          : t("发送一条消息，Tron 会在这里回复。")
                      }
                    />
                  )
                }
                ListFooterComponent={
                  runActive || pendingRequests.length || footerRunNotices ? (
                    <View>
                      {runActive ? (
                        <>
                          {liveRunTrace ? (
                            <RunProcess
                              trace={liveRunTrace}
                              live
                              noticeLabels={runNoticeLabels}
                              notices={liveRunRailNotices}
                            />
                          ) : null}
                          <LocalMessageBubble
                            role="ASSISTANT"
                            content={streamText}
                            assistantName={assistantName}
                            pending
                          />
                        </>
                      ) : null}
                      {pendingRequests.map((request) => (
                        <ApprovalCard
                          key={request.requestId}
                          labels={userInputLabels}
                          onSubmit={(answers) => void handleAnswer(request, answers)}
                          pending={answering}
                          request={request}
                          theme={agentTheme}
                        />
                      ))}
                      {!runActive && footerRunNotices ? (
                        footerRunTrace ? (
                          <RunProcess
                            trace={footerRunTrace}
                            noticeLabels={runNoticeLabels}
                            notices={footerRunNotices.notices}
                          />
                        ) : (
                          <RunNotice
                            notices={footerRunNotices.notices}
                            labels={runNoticeLabels}
                          />
                        )
                      ) : null}
                    </View>
                  ) : undefined
                }
                onContentSizeChange={() => {
                  if (
                    transcriptMessages.length ||
                    runActive ||
                    pendingRequests.length ||
                    footerRunNotices
                  ) {
                    requestAnimationFrame(() => scrollToBottom(false));
                  }
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                showsVerticalScrollIndicator={false}
              />

              <Composer
                attachmentUploadPending={attachmentUploading}
                attachLabel={t("添加附件")}
                clipboard={clipboardAdapter}
                composerHeader={
                  <View style={styles.workspaceHeader}>
                    <WorkspaceSelector
                      currentDirectoryCode={workingDirectoryCode}
                      directories={workspaceDirectories}
                      disabled={
                        loading ||
                        sessionStatus !== "online" ||
                        directoriesLoading
                      }
                      failed={directoriesFailed}
                      fixedDirectoryCode={
                        session?.directoryCode ?? draft?.directoryCode ?? null
                      }
                      labels={workspaceSelectorLabels}
                      loading={directoriesLoading}
                      onChange={handleWorkingDirectoryChange}
                      onRetry={() => void loadWorkspaceDirectories()}
                      workspaceLabel={workspaceLabel}
                    />
                  </View>
                }
                footerAddon={
                  <ModelEffortSelector
                    disabled={
                      loading || sessionStatus !== "online" || modelsLoading
                    }
                    effort={reasoningEffort}
                    labels={modelSelectorLabels}
                    loading={modelsLoading}
                    onSelectEffort={setReasoningEffort}
                    onSelectModel={handleSelectModel}
                    options={modelOptions}
                    selected={selectedModelOption}
                  />
                }
                disabledInput={loading || sessionStatus !== "online"}
                disabledInputReason={
                  sessionStatus === "online"
                    ? undefined
                    : t("连接信息缺失或电脑离线，请返回重新连接节点")
                }
                draft={input}
                inputPlaceholder={
                  assistantName
                    ? format("给 {name} 发消息…", { name: assistantName })
                    : t("输入消息…")
                }
                maxLength={8_000}
                onDraftChange={setInput}
                onEditQueuedMessage={(id, content) => {
                  setInput(content);
                  removeQueued(id);
                }}
                onPasteAttachment={queueComposerFile}
                onPickAttachment={pickAttachment}
                onRemoveAttachment={(id) => {
                  draftFilesRef.current.delete(id);
                  setPendingAttachments((previous) =>
                    previous.filter((item) => item.id !== id),
                  );
                  setAttachmentPreviews((previous) => {
                    const next = { ...previous };
                    delete next[id];
                    return next;
                  });
                }}
                onRemoveQueuedMessage={removeQueued}
                onReorderQueuedMessage={reorderQueued}
                onSend={(mode) => {
                  if (mode === "steer") void handleSteer();
                  else if (mode === "queue") queueInput();
                  else handleSend();
                }}
                onStop={() => void handleStop()}
                pasteLabel={t("粘贴图片或文件")}
                pendingAttachments={pendingAttachments.map(
                  (attachment): ComposerAttachment => ({
                    ...attachment,
                    kind: attachment.kind === "image" ? "image" : "file",
                    imageUrl:
                      attachmentPreviews[attachment.id] ??
                      attachment.imageUrl ??
                      null,
                  }),
                )}
                queueDisabled={Boolean(pendingAttachments.length)}
                queueLabel={t("排队")}
                queuedLabel={t("排队中")}
                queuedMessages={queued.map((item) => ({
                  id: item.id,
                  input: { content: item.content },
                }))}
                removeAttachmentLabel={(name) =>
                  format("移除附件：{name}", { name })
                }
                runningSubmitModes={["steer", "queue"]}
                sendDisabled={!canSend}
                sendLabel={t("发送消息")}
                sending={runActive}
                showStop={Boolean(activeRunId)}
                steerDisabled={Boolean(pendingAttachments.length)}
                steerLabel={t("引导")}
                stopLabel={t("停止")}
                style={{
                  paddingBottom: spacing.md,
                  paddingHorizontal: horizontalPadding,
                }}
                theme={agentTheme}
              />
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    headerWrap: {
      width: "100%",
    },
    headerIconButtonDisabled: {
      opacity: 0.4,
    },
    headerIconButton: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    offlineWrap: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: spacing.xl,
      paddingBottom: 80,
    },
    body: {
      flex: 1,
      width: "100%",
    },
    chatColumn: {
      flex: 1,
      minWidth: 0,
    },
    bannerWrap: {
      paddingTop: spacing.md,
      paddingHorizontal: 20,
    },
    messagesContent: {
      paddingTop: spacing.md,
      paddingBottom: spacing.lg,
    },
    messagesContentEmpty: {
      flexGrow: 1,
      justifyContent: "center",
    },
    workspaceTag: {
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: c.accentSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.accentBorder,
      maxWidth: 120,
    },
    workspaceTagText: {
      flexShrink: 1,
      color: c.accent,
      ...typography.caption,
      fontSize: 10,
      fontWeight: "600",
    },
    workspaceHeader: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: spacing.xs,
      paddingHorizontal: 2,
      paddingBottom: 2,
    },
    composerWrap: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      backgroundColor: c.background,
    },
    steerBadge: {
      alignSelf: "flex-end",
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      marginBottom: 4,
      marginRight: 4,
    },
    steerBadgeText: {
      color: c.muted,
      ...typography.caption,
      fontSize: 10,
    },
    queueList: {
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    queueItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    queueText: {
      flex: 1,
      color: c.muted,
      ...typography.caption,
    },
    runningBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    runningText: {
      flex: 1,
      color: c.muted,
      ...typography.caption,
    },
    modeButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    modeButtonDisabled: {
      opacity: 0.5,
    },
    modeLabel: {
      ...typography.caption,
      fontWeight: "600",
    },
    stopButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.danger,
    },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: spacing.sm,
      padding: spacing.sm,
      borderRadius: radius.card,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    composerInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      color: c.text,
      ...typography.body,
      lineHeight: 21,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.accent,
    },
    sendButtonDisabled: {
      opacity: 0.35,
    },
    composerHint: {
      color: c.muted,
      ...typography.caption,
      fontSize: 10,
      marginTop: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    pressed: {
      opacity: 0.75,
    },
  });