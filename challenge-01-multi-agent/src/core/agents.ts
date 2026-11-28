
type TaskStatus =
  | "pending" | "ready" | "running" | "awaiting_approval"
  | "done" | "failed" | "blocked" | "stale" | "cancelled";

export type Task = {
  id: string;
  role: "retriever" | "composer" | "critic";
  status: TaskStatus;
  dependsOn: string[];
  targetNodeId: string | null;
  requirementVersion: number;
  attempts: number; maxAttempts: number;
  inputRefs: string[]; outputRefs: string[];
  workflow?: { name: string; done: boolean }[];
};

class agent{
    name: string = "";
    acceptedTasks: Task[] = [];
    createWorkflow() {
        return [{name:"",done:false}]
    }
}

export type PlanResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; code: "unsupported_intent" | "invalid_count" | "no_target"; message: string };

export type ToolContext = { task: Task; sleep: (ms: number) => Promise<void> };
export type ToolResult = { summary: string };
export type Tool = (ctx: ToolContext) => Promise<ToolResult>;

export const TOOLS: Record<string, Tool> = {
  learn_instruction:   async ({ sleep }) => { await sleep(2000); return { summary: "已解析指令" }; },
  get_reference:       async ({ sleep }) => { await sleep(2600); return { summary: "已取得画布参考" }; },
  process_multi_modal: async ({ sleep }) => { await sleep(2400); return { summary: "已整理多模态输入" }; },
  add_node:            async ({ sleep }) => { await sleep(3200); return { summary: "已写入节点草稿" }; },
};

// 这个agent负责分工
export class plannerAgent extends agent{
    name = "分工Agent";

    plan = async (instruction: string): Promise<PlanResult> => {
        // 以确定性任务分拆模拟planner分拆任务
        const KEYWORDS = ["拆"];
        if (!KEYWORDS.some(item => instruction.includes(item))){
            return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." }
        };
        if (instruction.includes(KEYWORDS[0])) {
            const re = /创意简报[\s\S]*?拆[\s\S]*([一两三四五六七八九])个/;
            const m = instruction.match(re);
            if (!m) return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." };

            const tasks: Task[] = [];
            tasks.push(
                {id: "task_1", role: "retriever", status: "pending", dependsOn: [], targetNodeId: "brief", requirementVersion: 1,
                    attempts:0, maxAttempts: 5, inputRefs: [], outputRefs: []}
            );
            const count = "一两三四五六七八九".indexOf(m[1]) + 1
            for (let i = 1; i <= count; i++){
                tasks.push({id: `task_${i+1}`, role: "composer", status: "pending", dependsOn: ["task_1"], targetNodeId: "brief", 
                    requirementVersion: 1, attempts:0, maxAttempts: 5, inputRefs: [], outputRefs: []}
                );
            };
            return { ok: true, tasks: tasks } ;
        }
        return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." };
    };
};


// 这个agent负责提取特定node的reference
export class referenceRetrievingAgent extends agent{
    name = "检索Agent";
    createWorkflow() {
        return [{name: "learn_instruction",  done: false}, {name: "get_reference", done: false}];
    }
};

// 这个agent负责写入新node
export class nodeAddingAgent extends agent{
    name = "组成Agent";
    createWorkflow() {
        return [{name:"learn_instruction",done:false},
                {name:"process_multi_modal",done:false},
                {name:"add_node",done:false}];
    }
};

