import {
  TRON_PRODUCT_CODE,
  listDirectories,
  listAssistants,
  listNavigationMenus,
  listProjects,
  listSessionGroups,
  listSessionGroupsPage,
  listWorkspaceOptions,
  type ChatSession,
  type DirectoryRecord,
  type Assistant,
  type NavigationMenu,
  type ProjectRecord,
  type WorkspaceOption,
} from "../api/tron";
import type { SavedNode } from "../store/connections";
import type { NodeSessionContextValue } from "../store/nodeSession";

export type RequestForNode = NodeSessionContextValue["requestForNode"];

/** Catalog of one workspace on a node (sessions grouped as the node returns them). */
export interface NodeWorkspaceOverview {
  workspaceCode: string;
  label: string;
  name: string;
  status: string;
  sessions: ChatSession[];
  nextCursor: string | null;
  projects: ProjectRecord[];
  directories: DirectoryRecord[];
}

export interface NodeOverview {
  workspaces: NodeWorkspaceOverview[];
  /** Assistants are node-scoped; the list is not repeated per workspace. */
  assistants: Assistant[];
  /** First active workspace, used as the default for new sessions. */
  defaultWorkspaceCode: string | null;
  /** Product-defined chat sections, in product order. */
  menus: NavigationMenu[];
}

export interface LoadNodeOverviewOptions {
  /**
   * Also load projects and directories. Only the Tron session tree needs them;
   * the dashboard skips them to avoid two extra round trips per workspace.
   */
  includeCatalog?: boolean;
}

/** Keeps large workspace trees from exhausting the tunnel's in-flight budget. */
const WORKSPACE_FETCH_CONCURRENCY = 4;

function workspaceStatusActive(status: string): boolean {
  return status?.toUpperCase() === "ACTIVE";
}

function uniqueSessions(sessions: ChatSession[]): ChatSession[] {
  const byCode = new Map<string, ChatSession>();
  for (const session of sessions) {
    if (session?.sessionCode) byCode.set(session.sessionCode, session);
  }
  return [...byCode.values()];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function workspaceView(
  workspace: WorkspaceOption,
  sessions: ChatSession[],
  projects: ProjectRecord[],
  directories: DirectoryRecord[],
  nextCursor: string | null,
): NodeWorkspaceOverview {
  return {
    workspaceCode: workspace.workspaceCode,
    label: workspace.label?.trim() || workspace.name?.trim() || workspace.workspaceCode,
    name: workspace.name?.trim() || workspace.workspaceCode,
    status: workspace.status,
    sessions,
    nextCursor,
    projects,
    directories,
  };
}

/**
 * Reads the catalog for one node without changing the active node.
 *
 * Every active workspace is loaded so the drawer can group sessions by
 * workspace; only archived workspaces are used as a fallback when the node has
 * no active workspace at all. All calls share one tunnel and run with bounded
 * concurrency, and projects/directories are only fetched when requested.
 */
export async function loadNodeOverview(
  node: SavedNode,
  requestForNode: RequestForNode,
  options: LoadNodeOverviewOptions = {},
): Promise<NodeOverview> {
  return requestForNode<NodeOverview>(node, async ({ tunnel }) => {
    const workspaces = await listWorkspaceOptions({ tunnel });
    const activeWorkspaces = workspaces.filter((workspace) =>
      workspaceStatusActive(workspace.status),
    );
    // The fallback keeps an archived-only node readable; creating sessions on
    // it will fail the same way it does on the node itself.
    const visibleWorkspaces = activeWorkspaces.length
      ? activeWorkspaces
      : workspaces;
    const defaultWorkspaceCode =
      activeWorkspaces[0]?.workspaceCode ??
      workspaces[0]?.workspaceCode ??
      null;

    if (!visibleWorkspaces.length) {
      return {
        workspaces: [],
        assistants: [],
        defaultWorkspaceCode: null,
        menus: [],
      };
    }

    const isTronProduct = node.productCode === TRON_PRODUCT_CODE;
    const includeCatalog = isTronProduct && options.includeCatalog === true;

    const [loadedWorkspaces, assistants, menus] = await Promise.all([
      mapWithConcurrency(
        visibleWorkspaces,
        WORKSPACE_FETCH_CONCURRENCY,
        async (workspace): Promise<NodeWorkspaceOverview> => {
          const [sessionGroups, projects, directories] = await Promise.all([
            includeCatalog
              ? listSessionGroupsPage({ tunnel, workspaceCode: workspace.workspaceCode })
              : listSessionGroups({ tunnel, workspaceCode: workspace.workspaceCode })
                  .then((groups) => ({ groups, nextCursor: null })),
            includeCatalog
              ? listProjects({
                  tunnel,
                  workspaceCode: workspace.workspaceCode,
                }).catch(() => [])
              : Promise.resolve([]),
            includeCatalog
              ? listDirectories({
                  tunnel,
                  workspaceCode: workspace.workspaceCode,
                }).catch(() => [])
              : Promise.resolve([]),
          ]);
          return workspaceView(
            workspace,
            uniqueSessions(
              sessionGroups.groups.flatMap((group) => group.sessions ?? []),
            ),
            projects,
            directories,
            sessionGroups.nextCursor,
          );
        },
      ),
      listAssistants({
        tunnel,
        workspaceCode: defaultWorkspaceCode ?? undefined,
      }).catch(() => []),
      includeCatalog
        ? listNavigationMenus({ tunnel }).catch(() => [])
        : Promise.resolve([]),
    ]);

    return {
      workspaces: loadedWorkspaces,
      assistants,
      defaultWorkspaceCode,
      menus,
    };
  });
}
