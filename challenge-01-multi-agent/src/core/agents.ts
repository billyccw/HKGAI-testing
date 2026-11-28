
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
  | { type: "artifact"; artifactId: string };

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

export type Task = {
  id: string;
  role: "retriever" | "composer" | "critic";
  status: TaskStatus;
  dependsOn: string[];         // 順序約束 + 資料來源（已合流）
  targetNodeId: string | null;
  requirementVersion: number;
  attempts: number; maxAttempts: number;
  outputRefs: Artifact[];      // 只有生產者寫；寫入後不可變
  workflow?: { name: string; done: boolean }[];
};

export type ToolContext = {
  task: Task;
  inputs: Artifact[];                              // ← 由 stepRun 依 dependsOn 解析好
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
};

export type Tool = (ctx: ToolContext) => Promise<ToolResult>;

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
    // 檢索任務沒有上游：明確表達「無輸入」是正常狀態，不是失敗
    learn_instruction: async (ctx) => {
      await ctx.sleep(2000);
      if (ctx.inputs.length > 0) {
        throw new Error("检索任务不应收到上游资料");
      }
      return { summary: "已解析指令；检索任务无上游输入" };
    },

    // 產出 evidence：derivedFrom 指向文件庫的一筆文件
    get_reference: async (ctx) => {
      await ctx.sleep(2600);
      return {
        summary: "已取得画布参考（模拟来源：sample-reference v1）",
        outputs: [{
          key: "reference",
          content: "白模构图参考：同一主体、三个机位、保持空间关系。",
          derivedFrom: [{ type: "document", sourceId: "sample-reference", docVersion: 1 }],
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
    // 與檢索版相反：拿不到上游資料就拒絕執行
    learn_instruction: async (ctx) => {
      await ctx.sleep(2000);
      if (ctx.inputs.length === 0) {
        throw new Error("未收到上游资料，拒绝继续");
      }
      return { summary: `已解析指令；载入 ${ctx.inputs.length} 份上游资料` };
    },

    // 消化輸入，並在摘要裡列出引用來源（讓交接在事件流上可見）
    process_multi_modal: async (ctx) => {
      await ctx.sleep(2400);
      if (ctx.inputs.length === 0) {
        throw new Error("无可整理的多模态输入");
      }
      const ids = ctx.inputs.map(a => a.artifactId).join("、");
      return { summary: `已整理多模态输入（引用 ${ids}）` };
    },

    // 產出 draft：derivedFrom 指回它吃到的 artifact
    add_node: async (ctx) => {
      await ctx.sleep(3200);
      return {
        summary: "已写入节点草稿",
        outputs: [{
          key: "draft",
          content: `基于 ${ctx.inputs.length} 份参考生成的节点草稿`,
          derivedFrom: ctx.inputs.map(a => ({ type: "artifact" as const, artifactId: a.artifactId })),
        }],
      };
    },
  };
}
