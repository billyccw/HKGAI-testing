
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
};

export type PlanResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; code: "unsupported_intent" | "invalid_count" | "no_target"; message: string };

export async function plannerAgent(instruction: string): Promise<PlanResult>{
    // 以确定性任务分拆模拟planner分拆任务
    const KEYWORDS = ["拆"];
    if (!KEYWORDS.some(item => instruction.includes(item))){
        return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." }
    };
    if (instruction.includes(KEYWORDS[0])) {
        const re = /创意简报[\s\S]*?拆[\s\S]*([一二三四五六七八九])个/;
        const m = instruction.match(re);
        if (!m) return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." };

        const tasks: Task[] = [];
        tasks.push(
            {id: "task_1", role: "retriever", status: "pending", dependsOn: [], targetNodeId: "brief", requirementVersion: 1,
                attempts:0, maxAttempts: 5, inputRefs: [], outputRefs: []}
        );
        const count = "一二三四五六七八九".indexOf(m[1]) + 1
        for (let i = 1; i <= count; i++){
            tasks.push({id: `task_${i+1}`, role: "composer", status: "pending", dependsOn: ["task_1"], targetNodeId: "brief", 
                requirementVersion: 1, attempts:0, maxAttempts: 5, inputRefs: [], outputRefs: []}
            );
        };
        return { ok: true, tasks: tasks } ;
    }
    return { ok: false, code: "unsupported_intent", message: "未能拆分合理任务." };
};

/*
export async function referenceRetrievingAgent(instruction: string): Promise<PlanResult>{

};

export async function nodeAddingAgent(instruction: string): Promise<PlanResult>{

};

*/