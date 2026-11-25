import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  TRON_PRODUCT_CODE,
  type ChatSession,
  type NavigationMenu,
} from "../api/tron";
import { NodeLatencyText } from "../components/NodeLatency";
import { StatusDot } from "../components/StatusDot";
import { Ionicons } from "../components/icons";
import { useI18n } from "../i18n";
import { useConnections, type Product, type SavedNode } from "../store/connections";
import { useNodeSession } from "../store/nodeSession";
import {
  radius,
  spacing,
  typography,
  useTheme,
  useThemedStyles,
  type Palette,
} from "../theme";
import {
  describeError,
  formatNodeCount,
  formatRelativeTime,
  parseTimestamp,
} from "../utils/format";
import {
  loadNodeOverview,
  type NodeOverview,
} from "../utils/nodeOverview";
import type { ChatDraft } from "./types";
import { listSessionGroupsPage } from "../api/tron";

interface DrawerTreeProps {
  /** Refresh expanded nodes whenever the drawer is opened. */
  active: boolean;
  onOpenSession: (
    node: SavedNode,
    session: ChatSession,
    workspaceCode: string,
    workspaceLabel: string | null,
  ) => void;
  /**
   * Opens a local draft for the tapped group. No session exists until the
   * chat's first message is sent, matching Tron's draft tabs.
   */
  onOpenDraft: (
    node: SavedNode,
    workspaceCode: string,
    workspaceLabel: string | null,
    context?: Pick<ChatDraft, "projectCode" | "directoryCode">,
  ) => void;
}

interface TreeSession {
  session: ChatSession;
  detail?: string;
  workspaceCode: string;
}

/** A dynamically defined chat section from the product navigation menu. */
interface TreeMenuGroup {
  key: string;
  label: string;
  /** `chat.projects`, `chat.directories`, `chat.recents`, or `sessions`. */
  pageCode: string;
  unsupported?: boolean;
  sessions: TreeSession[];
  subgroups: TreeSubgroup[];
}

interface TreeSubgroup {
  key: string;
  label: string;
  sessions: TreeSession[];
  /** `projectCode` of a topic subgroup or `directoryCode` of a directory one. */
  projectCode?: string;
  directoryCode?: string;
}

interface TreeWorkspace {
  workspaceCode: string;
  label: string;
  name: string;
  groups: TreeMenuGroup[];
}

type NodeTreeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      workspaces: TreeWorkspace[];
      overview: NodeOverview;
      paging?: string;
      pageError?: string;
    };

function sortByUpdatedDesc(left: TreeSession, right: TreeSession): number {
  return (
    (parseTimestamp(right.session.updatedAt)?.getTime() ?? 0) -
    (parseTimestamp(left.session.updatedAt)?.getTime() ?? 0)
  );
}

function isManualSession(session: ChatSession): boolean {
  return (session.sourceType ?? "").toUpperCase() === "MANUAL";
}

function buildMenuGroups(
  node: SavedNode,
  workspace: NodeOverview["workspaces"][number],
  menus: NavigationMenu[],
): TreeMenuGroup[] {
  const allSessions: TreeSession[] = workspace.sessions.map((session) => ({
    session,
    workspaceCode: session.workspaceCode ?? workspace.workspaceCode,
  }));
  const manualSessions = allSessions.filter((item) =>
    isManualSession(item.session),
  );

  // Other products do not expose sidebar widgets; keep their single flat list.
  if (node.productCode !== TRON_PRODUCT_CODE) {
    if (!allSessions.length) return [];
    return [
      {
        key: "sessions",
        label: "",
        pageCode: "sessions",
        sessions: [...allSessions].sort(sortByUpdatedDesc),
        subgroups: [],
      },
    ];
  }

  return menus.map((menu): TreeMenuGroup => {
    const key = menu.menuCode || menu.pageCode;
    if (menu.pageCode === "chat.projects") {
      const subgroups = workspace.projects.map((project) => ({
        key: `project:${project.projectCode}`,
        label: project.name || project.projectCode,
        projectCode: project.projectCode,
        sessions: manualSessions
          .filter(
            (item) => item.session.projectCode === project.projectCode,
          )
          .sort(sortByUpdatedDesc),
      }));
      return {
        key,
        label: menu.label,
        pageCode: menu.pageCode,
        sessions: [],
        subgroups,
      };
    }
    if (menu.pageCode === "chat.directories") {
      const subgroups = workspace.directories.map((directory) => ({
        key: `directory:${directory.directoryCode}`,
        label: directory.name || directory.path || directory.directoryCode,
        directoryCode: directory.directoryCode,
        sessions: manualSessions
          .filter(
            (item) => item.session.directoryCode === directory.directoryCode,
          )
          .sort(sortByUpdatedDesc),
      }));
      return {
        key,
        label: menu.label,
        pageCode: menu.pageCode,
        sessions: [],
        subgroups,
      };
    }
    if (menu.pageCode === "chat.recents") {
      const sessions = manualSessions
        .filter(
          (item) =>
            !item.session.projectCode && !item.session.directoryCode,
        )
        .sort(sortByUpdatedDesc);
      return {
        key,
        label: menu.label,
        pageCode: menu.pageCode,
        sessions,
        subgroups: [],
      };
    }
    return {
      key,
      label: menu.label,
      pageCode: menu.pageCode,
      unsupported: true,
      sessions: [],
      subgroups: [],
    };
  });
}

function buildNodeWorkspaces(
  node: SavedNode,
  overview: NodeOverview,
  menus: NavigationMenu[],
): TreeWorkspace[] {
  return overview.workspaces.map((workspace) => ({
    workspaceCode: workspace.workspaceCode,
    label: workspace.label || workspace.name || workspace.workspaceCode,
    name: workspace.name || workspace.workspaceCode,
    groups: buildMenuGroups(node, workspace, menus),
  }));
}

export function DrawerTree({
  active,
  onOpenSession,
  onOpenDraft,
}: DrawerTreeProps) {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { t, format } = useI18n();
  const { requestForNode, contentEpoch } = useNodeSession();
  const { products, nodes } = useConnections();

  const [expandedProducts, setExpandedProducts] = useState<
    Record<string, boolean>
  >({});
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<
    Record<string, boolean>
  >({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const [nodeStates, setNodeStates] = useState<Record<string, NodeTreeState>>(
    {},
  );
  const wasActiveRef = useRef(false);

  // Session metadata is memory-only conversation content: drop it when the
  // active node changes, the app backgrounds, or a node goes offline.
  useEffect(() => {
    if (contentEpoch === 0) return;
    setNodeStates({});
    setExpandedWorkspaces({});
    setExpandedGroups({});
  }, [contentEpoch]);

  const productsWithNodes = useMemo(
    () =>
      products
        .map((product) => ({
          product,
          nodes: nodes.filter((node) => node.productCode === product.code),
        }))
        .filter((entry) => entry.nodes.length > 0),
    [nodes, products],
  );

  const fallbackMenus = useMemo<NavigationMenu[]>(
    () => [
      {
        menuCode: "CHAT_PROJECTS",
        label: t("主题", "topics"),
        pageCode: "chat.projects",
        icon: null,
      },
      {
        menuCode: "CHAT_DIRECTORIES",
        label: t("工作区"),
        pageCode: "chat.directories",
        icon: null,
      },
      {
        menuCode: "CHAT_RECENTS",
        label: t("随聊"),
        pageCode: "chat.recents",
        icon: null,
      },
    ],
    [t],
  );

  const loadNode = useCallback(
    async (node: SavedNode) => {
      setNodeStates((previous) => ({
        ...previous,
        [node.id]: { status: "loading" },
      }));
      try {
        const overview = await loadNodeOverview(node, requestForNode, {
          includeCatalog: node.productCode === TRON_PRODUCT_CODE,
        });
        const menus = overview.menus.length ? overview.menus : fallbackMenus;
        setNodeStates((previous) => ({
          ...previous,
          [node.id]: {
            status: "ready",
            workspaces: buildNodeWorkspaces(node, overview, menus),
            overview,
          },
        }));
      } catch (error) {
        setNodeStates((previous) => ({
          ...previous,
          [node.id]: {
            status: "error",
            message: describeError(error),
          },
        }));
      }
    },
    [fallbackMenus, requestForNode],
  );

  const loadMore = async (node: SavedNode, snapshot: Extract<NodeTreeState, { status: "ready" }>, code: string) => {
    const workspace = snapshot.overview.workspaces.find((item) => item.workspaceCode === code);
    if (!workspace?.nextCursor || snapshot.paging) return;
    const loading = { ...snapshot, paging: code, pageError: undefined };
    setNodeStates((previous) => ({ ...previous, [node.id]: loading }));
    try {
      const page = await requestForNode(node, ({ tunnel }) =>
        listSessionGroupsPage({ tunnel, workspaceCode: code, cursor: workspace.nextCursor }),
      );
      const sessions = new Map(workspace.sessions.map((session) => [session.sessionCode, session]));
      for (const group of page.groups) {
        for (const session of group.sessions) sessions.set(session.sessionCode, session);
      }
      const overview = {
        ...snapshot.overview,
        workspaces: snapshot.overview.workspaces.map((item) => item === workspace
          ? { ...item, sessions: [...sessions.values()], nextCursor: page.nextCursor }
          : item),
      };
      const menus = overview.menus.length ? overview.menus : fallbackMenus;
      setNodeStates((previous) => previous[node.id] === loading ? {
        ...previous, [node.id]: { status: "ready", overview, workspaces: buildNodeWorkspaces(node, overview, menus) },
      } : previous);
    } catch (error) {
      setNodeStates((previous) => previous[node.id] === loading ? {
        ...previous, [node.id]: { ...snapshot, pageError: describeError(error) },
      } : previous);
    }
  };

  /**
   * Opens a local draft on the tapped node. The node stays untouched until the
   * chat's first send, exactly like Tron's draft tab, so tapping `+` repeatedly
   * never leaves empty sessions behind.
   */
  const openDraft = useCallback(
    (
      node: SavedNode,
      workspace: TreeWorkspace,
      context: { projectCode?: string; directoryCode?: string } = {},
    ) => {
      onOpenDraft(node, workspace.workspaceCode, workspace.label, context);
    },
    [onOpenDraft],
  );

  useEffect(() => {
    if (!active) {
      wasActiveRef.current = false;
      return;
    }
    if (wasActiveRef.current) return;
    wasActiveRef.current = true;
    for (const node of nodes) {
      if (expandedNodes[node.id]) void loadNode(node);
    }
    // Only react to the drawer opening; expansion state is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const toggleProduct = (product: Product) => {
    setExpandedProducts((previous) => ({
      ...previous,
      [product.code]: previous[product.code] === false,
    }));
  };

  const toggleNode = (node: SavedNode) => {
    const nextOpen = !expandedNodes[node.id];
    setExpandedNodes((previous) => ({ ...previous, [node.id]: nextOpen }));
    if (!nextOpen) return;
    const state = nodeStates[node.id];
    if (!state || state.status === "error") {
      void loadNode(node);
    }
  };

  const toggleWorkspace = (workspaceId: string) => {
    setExpandedWorkspaces((previous) => {
      // Workspaces start expanded; only an explicit `false` closes them.
      const open = previous[workspaceId] !== false;
      return { ...previous, [workspaceId]: !open };
    });
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((previous) => ({
      ...previous,
      [groupId]: !previous[groupId],
    }));
  };

  // Menu sections start expanded, so an unset key counts as open.
  const toggleMenuGroup = (groupId: string) => {
    setExpandedGroups((previous) => ({
      ...previous,
      [groupId]: previous[groupId] === false,
    }));
  };

  const productOpen = (product: Product) =>
    expandedProducts[product.code] !== false;

  if (!productsWithNodes.length) {
    return (
      <View style={styles.emptyState}>
        <Ionicons name="git-network-outline" size={22} color={palette.muted} />
        <Text style={styles.emptyText}>{t("还没有节点")}</Text>
        <Text style={styles.emptyHint}>{t("请先添加一个节点")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {productsWithNodes.map(({ product, nodes: productNodes }) => (
        <View key={product.code} style={styles.productBlock}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: productOpen(product) }}
            accessibilityLabel={product.name}
            onPress={() => toggleProduct(product)}
            style={({ pressed }) => [
              styles.productRow,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.productIcon}>
              <Ionicons name="cube-outline" size={15} color={palette.accent} />
            </View>
            <Text style={styles.productName} numberOfLines={1}>
              {product.name}
            </Text>
            <Text style={styles.productCount}>
              {formatNodeCount(productNodes.length)}
            </Text>
            <Ionicons
              name={productOpen(product) ? "chevron-down" : "chevron-forward"}
              size={14}
              color={palette.muted}
            />
          </Pressable>

          {productOpen(product)
            ? productNodes.map((node) => {
                const nodeOpen = Boolean(expandedNodes[node.id]);
                const state = nodeStates[node.id];

                const renderSession = (item: TreeSession) => (
                  <Pressable
                    key={item.session.sessionCode}
                    accessibilityRole="button"
                    accessibilityLabel={format("打开会话：{title}", {
                      title:
                        item.session.title?.trim() || t("未命名会话"),
                    })}
                    onPress={() =>
                      onOpenSession(
                        node,
                        item.session,
                        item.workspaceCode,
                        state?.status === "ready"
                          ? (state.workspaces.find(
                              (workspace) =>
                                workspace.workspaceCode === item.workspaceCode,
                            )?.label ?? null)
                          : null,
                      )
                    }
                    style={({ pressed }) => [
                      styles.sessionRow,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.sessionDot} />
                    <View style={styles.sessionText}>
                      <Text style={styles.sessionTitle} numberOfLines={1}>
                        {item.session.title?.trim() || t("未命名会话")}
                      </Text>
                      <Text style={styles.sessionMeta} numberOfLines={1}>
                        {[item.detail, formatRelativeTime(item.session.updatedAt)]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                  </Pressable>
                );

                const renderSubgroup = (
                  workspace: TreeWorkspace,
                  group: TreeMenuGroup,
                  subgroup: TreeSubgroup,
                ) => {
                  const subgroupId = `${node.id}:${workspace.workspaceCode}:${group.key}:${subgroup.key}`;
                  const open = expandedGroups[subgroupId] === true;
                  return (
                    <View key={subgroup.key}>
                      <View style={styles.subgroupHeader}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ expanded: open }}
                          accessibilityLabel={format(
                            open
                              ? "收起分组 {name}"
                              : "展开分组 {name}",
                            { name: subgroup.label },
                          )}
                          onPress={() => toggleGroup(subgroupId)}
                          style={({ pressed }) => [
                            styles.subgroupRow,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Ionicons
                            name={
                              group.pageCode === "chat.directories"
                                ? "folder-outline"
                                : "albums-outline"
                            }
                            size={12}
                            color={palette.muted}
                          />
                          <Text
                            style={styles.subgroupLabel}
                            numberOfLines={1}
                          >
                            {subgroup.label}
                          </Text>
                          <Text style={styles.groupCount}>
                            {subgroup.sessions.length}
                          </Text>
                          <Ionicons
                            name={open ? "chevron-down" : "chevron-forward"}
                            size={11}
                            color={palette.muted}
                          />
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={format(
                            "在 {name} 新建会话",
                            { name: subgroup.label },
                          )}
                          hitSlop={8}
                          onPress={() =>
                            openDraft(node, workspace, {
                              projectCode: subgroup.projectCode,
                              directoryCode: subgroup.directoryCode,
                            })
                          }
                          style={({ pressed }) => [
                            styles.groupCreate,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Ionicons name="add" size={14} color={palette.muted} />
                        </Pressable>
                      </View>
                      {open ? (
                        <View style={styles.sessionList}>
                          {subgroup.sessions.map(renderSession)}
                        </View>
                      ) : null}
                    </View>
                  );
                };

                const renderMenuGroup = (
                  workspace: TreeWorkspace,
                  group: TreeMenuGroup,
                ) => {
                  // Non-menu products keep a plain session list.
                  if (group.pageCode === "sessions") {
                    return (
                      <View key={group.key} style={styles.sessionList}>
                        {group.sessions.map(renderSession)}
                      </View>
                    );
                  }
                  const menuId = `${node.id}:${workspace.workspaceCode}:${group.key}`;
                  const open = expandedGroups[menuId] !== false;
                  const count =
                    group.sessions.length +
                    group.subgroups.reduce(
                      (total, subgroup) => total + subgroup.sessions.length,
                      0,
                    );
                  return (
                    <View key={group.key}>
                      <View style={styles.groupHeader}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ expanded: open }}
                          accessibilityLabel={format(
                            open
                              ? "收起分组 {name}"
                              : "展开分组 {name}",
                            { name: group.label },
                          )}
                          onPress={() => toggleMenuGroup(menuId)}
                          style={({ pressed }) => [
                            styles.groupRow,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Ionicons
                            name={
                              group.pageCode === "chat.projects"
                                ? "albums-outline"
                                : group.pageCode === "chat.directories"
                                  ? "folder-outline"
                                  : group.pageCode === "chat.recents"
                                    ? "chatbubbles-outline"
                                    : "apps-outline"
                            }
                            size={14}
                            color={palette.muted}
                          />
                          <Text style={styles.groupLabel}>{group.label}</Text>
                          <Text style={styles.groupCount}>{count}</Text>
                          <Ionicons
                            name={open ? "chevron-down" : "chevron-forward"}
                            size={12}
                            color={palette.muted}
                          />
                        </Pressable>
                        {group.unsupported ? null : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={format(
                              "在 {workspace} 的 {group} 新建会话",
                              { workspace: workspace.label, group: group.label },
                            )}
                            hitSlop={6}
                            onPress={() => openDraft(node, workspace)}
                            style={({ pressed }) => [
                              styles.groupCreate,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Ionicons name="add" size={14} color={palette.muted} />
                          </Pressable>
                        )}
                      </View>
                      {open ? (
                        <View style={styles.menuBody}>
                          {group.unsupported ? (
                            <Text style={styles.hint}>
                              {t("手机暂不支持这个分组。")}
                            </Text>
                          ) : group.subgroups.length ? (
                            group.subgroups.map((subgroup) =>
                              renderSubgroup(workspace, group, subgroup),
                            )
                          ) : group.sessions.length ? (
                            <View style={styles.sessionList}>
                              {group.sessions.map(renderSession)}
                            </View>
                          ) : (
                            <Text style={styles.hint}>{t("没有会话")}</Text>
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                };

                const renderWorkspace = (workspace: TreeWorkspace) => {
                  const workspaceId = `${node.id}:${workspace.workspaceCode}`;
                  const workspaceOpen =
                    expandedWorkspaces[workspaceId] !== false;
                  const sessionCount = workspace.groups.reduce(
                    (total, group) =>
                      total +
                      group.sessions.length +
                      group.subgroups.reduce(
                        (sum, subgroup) => sum + subgroup.sessions.length,
                        0,
                      ),
                    0,
                  );

                  // Products without navigation menus list their sessions
                  // flat, so the workspace row itself carries the create action.
                  const flatGroup =
                    workspace.groups.length === 1 &&
                    workspace.groups[0]?.pageCode === "sessions"
                      ? workspace.groups[0]
                      : null;

                  return (
                    <View key={workspace.workspaceCode}>
                      <View style={styles.groupHeader}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: workspaceOpen }}
                        accessibilityLabel={format(
                          workspaceOpen
                            ? "收起工作空间 {name}"
                            : "展开工作空间 {name}",
                          { name: workspace.label },
                        )}
                        onPress={() => toggleWorkspace(workspaceId)}
                        style={({ pressed }) => [
                          styles.workspaceRow,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Ionicons
                          name="layers-outline"
                          size={13}
                          color={palette.accent}
                        />
                        <Text
                          style={styles.workspaceLabel}
                          numberOfLines={1}
                        >
                          {workspace.label}
                        </Text>
                        <Text style={styles.workspaceCount}>
                          {sessionCount}
                        </Text>
                        <Ionicons
                          name={
                            workspaceOpen ? "chevron-down" : "chevron-forward"
                          }
                          size={12}
                          color={palette.muted}
                        />
                      </Pressable>
                      {flatGroup ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={format(
                            "在 {workspace} 新建会话",
                            { workspace: workspace.label },
                          )}
                          hitSlop={6}
                          onPress={() => openDraft(node, workspace)}
                          style={({ pressed }) => [
                            styles.groupCreate,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Ionicons name="add" size={14} color={palette.muted} />
                        </Pressable>
                      ) : null}
                      </View>

                      {workspaceOpen ? (
                        <View style={styles.workspaceBody}>
                          {workspace.groups.length === 0 ? (
                            <Text style={styles.hint}>{t("没有会话")}</Text>
                          ) : (
                            workspace.groups.map((group) =>
                              renderMenuGroup(workspace, group),
                            )
                          )}
                          {state?.status === "ready" && state.overview.workspaces.some((item) =>
                            item.workspaceCode === workspace.workspaceCode && item.nextCursor,
                          ) ? (
                            <Pressable accessibilityRole="button" disabled={Boolean(state.paging)}
                              onPress={() => void loadMore(node, state, workspace.workspaceCode)}>
                              <Text style={styles.retryText}>{t("加载更多会话")}</Text>
                            </Pressable>
                          ) : null}
                          {state?.status === "ready" && state.pageError ? (
                            <Text style={styles.errorText}>{state.pageError}</Text>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  );
                };

                return (
                  <View key={node.id}>
                    <View style={styles.nodeRow}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: nodeOpen }}
                        accessibilityLabel={format("打开节点：{name}", {
                          name: node.name,
                        })}
                        onPress={() => toggleNode(node)}
                        style={({ pressed }) => [
                          styles.nodeToggle,
                          pressed && styles.pressed,
                        ]}
                      >
                        <StatusDot online={node.online} size={6} />
                        <View style={styles.nodeText}>
                          <Text style={styles.nodeName} numberOfLines={1}>
                            {node.name}
                          </Text>
                          <Text style={styles.nodeAddress} numberOfLines={1}>
                            {node.baseUrl}
                          </Text>
                        </View>
                        <NodeLatencyText
                          nodeId={node.id}
                          showPlaceholder
                          style={styles.nodeLatency}
                        />
                        {state?.status === "loading" ? (
                          <ActivityIndicator
                            size="small"
                            color={palette.accent}
                          />
                        ) : (
                          <Ionicons
                            name={nodeOpen ? "chevron-down" : "chevron-forward"}
                            size={13}
                            color={palette.muted}
                          />
                        )}
                      </Pressable>
                    </View>

                    {nodeOpen ? (
                      <View style={styles.nodeBody}>
                        {state?.status === "loading" ? (
                          <Text style={styles.hint}>
                            {t("正在读取会话…")}
                          </Text>
                        ) : state?.status === "error" ? (
                          <View style={styles.errorRow}>
                            <Text style={styles.errorText} numberOfLines={3}>
                              {state.message}
                            </Text>
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => void loadNode(node)}
                              hitSlop={6}
                            >
                              <Text style={styles.retryText}>{t("重试")}</Text>
                            </Pressable>
                          </View>
                        ) : state?.status === "ready" &&
                          state.workspaces.length === 0 ? (
                          <Text style={styles.hint}>
                            {t("这台电脑还没有可用的工作空间。")}
                          </Text>
                        ) : state?.status === "ready" ? (
                          state.workspaces.map(renderWorkspace)
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })
            : null}
        </View>
      ))}
    </View>
  );
}

const createStyles = (c: Palette) =>
  StyleSheet.create({
    root: {
      gap: spacing.xs,
    },
    productBlock: {
      gap: 2,
    },
    productRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 42,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.control,
    },
    productIcon: {
      width: 26,
      height: 26,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.accentSoft,
    },
    productName: {
      flex: 1,
      color: c.text,
      ...typography.bodyStrong,
      fontSize: 13,
    },
    productCount: {
      color: c.muted,
      ...typography.caption,
      fontSize: 10,
    },
    nodeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      paddingLeft: spacing.xl,
      paddingRight: spacing.xs,
      borderRadius: radius.control,
    },
    nodeToggle: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 40,
      minWidth: 0,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
    },
    subgroupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
    },
    // Same affordance as the desktop section header: a bare 24px icon that
    // only tints on press, no filled circle.
    groupCreate: {
      width: 24,
      height: 24,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
    },
    nodeText: {
      flex: 1,
      gap: 1,
      minWidth: 0,
    },
    nodeName: {
      color: c.text,
      ...typography.body,
      fontSize: 12,
    },
    nodeAddress: {
      color: c.muted,
      fontSize: 9,
      letterSpacing: 0.2,
    },
    nodeLatency: {
      marginLeft: spacing.xs,
      fontSize: 9,
    },
    nodeBody: {
      paddingLeft: spacing.xl + spacing.md,
      paddingRight: spacing.sm,
      paddingBottom: spacing.sm,
      gap: 2,
    },
    workspaceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 32,
      paddingHorizontal: spacing.sm,
      borderRadius: 8,
    },
    workspaceLabel: {
      flex: 1,
      color: c.text,
      ...typography.bodyStrong,
      fontSize: 11,
    },
    workspaceCount: {
      color: c.muted,
      ...typography.caption,
      fontSize: 10,
    },
    workspaceBody: {
      paddingLeft: spacing.xs,
      gap: 1,
    },
    hint: {
      color: c.muted,
      ...typography.caption,
      fontSize: 11,
      paddingVertical: spacing.sm,
    },
    errorRow: {
      gap: 4,
      paddingVertical: spacing.sm,
    },
    errorText: {
      color: c.danger,
      ...typography.caption,
      fontSize: 11,
      lineHeight: 16,
    },
    retryText: {
      color: c.accent,
      ...typography.caption,
      fontWeight: "600",
    },
    groupRow: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 34,
      paddingHorizontal: spacing.sm,
      borderRadius: 8,
      minWidth: 0,
    },
    menuBody: {
      paddingLeft: spacing.md,
      gap: 1,
    },
    subgroupRow: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 32,
      paddingHorizontal: spacing.sm,
      borderRadius: 8,
    },
    subgroupLabel: {
      flex: 1,
      color: c.text,
      ...typography.body,
      fontSize: 11,
    },
    groupLabel: {
      flex: 1,
      color: c.muted,
      ...typography.label,
      fontSize: 11,
    },
    groupCount: {
      color: c.muted,
      ...typography.caption,
      fontSize: 10,
    },
    sessionList: {
      gap: 1,
      paddingLeft: spacing.md,
    },
    sessionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      minHeight: 36,
      paddingHorizontal: spacing.sm,
      borderRadius: 8,
    },
    sessionDot: {
      width: 3,
      height: 3,
      borderRadius: 2,
      backgroundColor: c.accent,
      opacity: 0.7,
    },
    sessionText: {
      flex: 1,
      gap: 1,
      minWidth: 0,
    },
    sessionTitle: {
      color: c.text,
      ...typography.body,
      fontSize: 11,
    },
    sessionMeta: {
      color: c.muted,
      ...typography.caption,
      fontSize: 9,
    },
    emptyState: {
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.xxxl,
      paddingHorizontal: spacing.lg,
    },
    emptyText: {
      color: c.text,
      ...typography.bodyStrong,
      fontSize: 13,
    },
    emptyHint: {
      color: c.muted,
      ...typography.caption,
      fontSize: 11,
      textAlign: "center",
    },
    pressed: {
      opacity: 0.72,
    },
  });
