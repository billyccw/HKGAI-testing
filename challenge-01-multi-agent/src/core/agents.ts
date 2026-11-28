import { type CanvasNode, type WorkflowEdge } from "./canvas.ts";

type TaskStatus =
  | "pending" | "ready" | "running" | "awaiting_approval"
  | "done" | "failed" | "blocked" | "stale" | "cancelled";

/**
 * 產物的來源邊。分型是關鍵：
 * document = 來自專案文件庫（RAG），必帶版本號
 * artifact = 來自本 run 內某個上游任務的產物
 */
export type ArtifactRef = 
  | { type: "document"; sourceId: string; docVersion: number }
  | { type: "artifact"; artifactId: string }
  | { type: "node"; nodeId: string }; // artifact可以来自画布节点
/**
 * 產物。刻意不設 kind：
 * 「是不是 evidence」由 derivedFrom 是否含 document 推導，不再另外存一個可能漂移的標籤。
 */
export type Artifact = {
  artifactId: string;          // art-<taskId>-<key>，確定性、可冪等覆寫
  producedBy: string;          // 生產者 taskId
  requirementVersion: number;  // 出生版本，供過期判斷
  content: string;
  derivedFrom: ArtifactRef[];  // 一律要交代來源
};

// 待审批动作，具体需要审批的是创建节点并连线（add_node）
export type PendingAction = {
  actionId: string;
  taskId: string;
  requirementVersion: number;
  payload: {
    title: string;
    textContent: string;
    connectFrom: string;
  };
};

export type Task = {
  id: string;
  role: "retriever" | "composer" | "critic";
  status: TaskStatus;
  dependsOn: string[];
  targetNodeId: string | null;
  requirementVersion: number;
  attempts: number; maxAttempts: number;
  outputRefs: Artifact[];      // 只有生產者寫；寫入後不可變
  workflow?: { name: string; done: boolean }[];
  error?: string;     // ← 失敗原因
};

export type ToolContext = {
  task: Task;
  inputs: Artifact[];                              // ← 由 stepRun 依 dependsOn 解析好
  snapshot: { nodes: CanvasNode[]; edges: WorkflowEdge[] };   // ← 新增：唯讀畫布
  slot: number | null;
  sleep: (ms: number) => Promise<void>;
};

export type ToolOutput = {
  key: string;                                     // 用來組 artifactId
  content: string;
  derivedFrom?: ArtifactRef[];
};

export type ToolResult = {
  summary: string;
  outputs?: ToolOutput[];
  proposes?: PendingAction;      // ← 新增：提出審批請求
};

export type Tool = (ctx: ToolContext) => Promise<ToolResult>;

function findBrief(snapshot: ToolContext["snapshot"]) {
  const brief = snapshot.nodes.find((n) => n.data.title.trim() === "创意简报");
  if (!brief) {
    const titles = snapshot.nodes.map((n) => n.data.title).join("、") || "（画布为空）";
    throw new Error(`画布上找不到标题为「创意简报」的节点；现有节点：${titles}`);
  }
  return brief;
}

function findReferences(snapshot: ToolContext["snapshot"], briefId: string) {
  const linkedIds = snapshot.edges
    .filter((e) => e.source === briefId || e.target === briefId)
    .map((e) => (e.source === briefId ? e.target : e.source));

  const refs = snapshot.nodes.filter(
    (n) => linkedIds.includes(n.id) && n.data.nodeType === "reference",
  );
  if (refs.length === 0) {
    throw new Error("画布上找不到与「创意简报」相连的参考节点；请先连接一个节点类型为「参考」的节点");
  }
  return refs;
}

/** 把上游 artifact 的內容拼成參考描述 */
function referenceText(inputs: Artifact[]): string {
  return inputs.map((a) => a.content.trim()).filter(Boolean).join("\n");
}

/**
 * 角色契約。stepRun 只認識 Task.role（字串），
 * 因此每個角色必須對外提供同樣的三件事，才能被統一調度。
 */
export abstract class agent {
  abstract name: string;
  abstract createWorkflow(): { name: string; done: boolean }[];
  /** 角色專屬工具表：步名 → 實作。沒登記的步名一律視為未授權工具 */
  abstract tools: Record<string, Tool>;
}


export type PlanResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; code: "unsupported_intent" | "invalid_count" | "no_target"; message: string };


export class plannerAgent extends agent {
  name = "分工Agent";
  tools: Record<string, Tool> = {};      // 規劃者不執行工具
  createWorkflow() {
    return [];                            // 規劃者沒有工作流
  }

  plan = async (instruction: string): Promise<PlanResult> => {
    const KEYWORDS = ["拆"];
    if (!KEYWORDS.some(item => instruction.includes(item))) {
      return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." };
    }
    const m = instruction.match(/创意简报[\s\S]*?拆[\s\S]*([一两三四五六七八九])个/);
    if (!m) return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." };

    const tasks: Task[] = [];
    tasks.push({
      id: "task_1", role: "retriever", status: "pending", dependsOn: [],
      targetNodeId: "brief", requirementVersion: 1,
      attempts: 0, maxAttempts: 5,
      outputRefs: [],                    // ← 取代原本的 inputRefs: [], outputRefs: []
    });

    const count = "一两三四五六七八九".indexOf(m[1]) + 1;
    for (let i = 1; i <= count; i++) {
      tasks.push({
        id: `task_${i + 1}`, role: "composer", status: "pending", dependsOn: ["task_1"],
        targetNodeId: "brief", requirementVersion: 1,
        attempts: 0, maxAttempts: 5,
        outputRefs: [],
      });
    }
    return { ok: true, tasks };
  };
}

// ── 检索 Agent：無上游輸入，產出特定node的reference ──────────
export class referenceRetrievingAgent extends agent {
  name = "检索Agent";

  createWorkflow() {
    return [
      { name: "learn_instruction", done: false },
      { name: "get_reference", done: false },
    ];
  }

  tools: Record<string, Tool> = {
    learn_instruction: async (ctx) => {
      await ctx.sleep(2000);
      const brief = findBrief(ctx.snapshot);
      const refs = findReferences(ctx.snapshot, brief.id);
      return { summary: `已解析指令；定位到「${brief.data.title}」与 ${refs.length} 个参考节点` };
    },

    // 產出 artifact：內容是參考節點的描述，來源記為畫布節點
    get_reference: async (ctx) => {
      await ctx.sleep(2600);
      const brief = findBrief(ctx.snapshot);
      const refs = findReferences(ctx.snapshot, brief.id);
      return {
        summary: `已取得 ${refs.length} 个参考节点的描述`,
        outputs: [{
          key: "reference",
          content: refs.map((r) => r.data.textContent.trim()).filter(Boolean).join("\n"),
          derivedFrom: [
            { type: "node" as const, nodeId: brief.id },
            ...refs.map((r) => ({ type: "node" as const, nodeId: r.id })),
          ],
        }],
      };
    },
  };
}

// ── 组成 Agent：依賴上游，必須收到資料才 add node ──────────────────
export class nodeAddingAgent extends agent {
  name = "组成Agent";

  createWorkflow() {
    return [
      { name: "learn_instruction", done: false },
      { name: "process_multi_modal", done: false },
      { name: "add_node", done: false },
    ];
  }

   tools: Record<string, Tool> = {
    // 拿不到上游資料就拒絕執行
    learn_instruction: async (ctx) => {
      await ctx.sleep(2000);
      if (ctx.inputs.length === 0) throw new Error("未收到上游资料，拒绝继续");
      return { summary: `已解析指令；载入 ${ctx.inputs.length} 份上游资料` };
    },

    // 這一步「產出草稿」——把參考节点的文本描述變成自己的 artifact
    process_multi_modal: async (ctx) => {
      await ctx.sleep(2400);
      const text = referenceText(ctx.inputs);
      if (!text) throw new Error("上游资料中没有任何参考描述");
      return {
        summary: `已整理参考描述（${text.length} 字）`,
        outputs: [{
          key: "draft",
          content: `参考描述：${text}`,
          derivedFrom: ctx.inputs.map((a) => ({ type: "artifact" as const, artifactId: a.artifactId })),
        }],
      };
    },

    // 這一步只提案，不寫畫布、不寫 outputRefs，等审批通过
    add_node: async (ctx) => {
      await ctx.sleep(3200);
      const brief = findBrief(ctx.snapshot);       // 只為了取 connectFrom
      const slot = ctx.slot ?? 1;
      const text = referenceText(ctx.inputs);

      return {
        summary: `准备新建「机位 ${slot}」（需审批）`,
        proposes: {
          actionId: `act-${ctx.task.id}-add_node`,
          taskId: ctx.task.id,
          requirementVersion: ctx.task.requirementVersion,
          payload: {
            title: `机位 ${slot}`,
            textContent: `机位 ${slot}\n参考描述：${text}`,
            connectFrom: brief.id,
          },
        },
      };
    },
  };
}
