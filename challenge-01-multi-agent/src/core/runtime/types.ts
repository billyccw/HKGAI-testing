import { type Task, type PendingAction } from "../agents.ts";
import { type AgentEvent } from "../multiAgents.ts";
import { type CanvasNode, type WorkflowEdge } from "../canvas.ts";

export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "completed" | "blocked" | "cancelled";

export type ApprovalRecord = {
  actionId: string;
  requirementVersion: number; 
  decision: "approved" | "rejected";
  decidedAt: string;
};

export type RunRecord = {
  runId: number;
  requirementVersion: number;
  requirements: { version: number; text: string; createdAt: string }[];
  baseSnapshot: { nodes: CanvasNode[]; edges: WorkflowEdge[] }; // 啟動當下的畫布快照：工具的唯讀視圖，執行期間不變 
  tasks: Task[];
  events: AgentEvent[];
  pendingActions: PendingAction[]; // 当前在等待使用者批准的提案（三個 composer 可能同輪提出多筆） 
  approvals: ApprovalRecord[]; // 已決策的紀錄：去重 + 版本綁定
  status: RunStatus;
  output?: string;
};

export type RunTraceView = {
  id: string;
  runId: number;
  mode: "multi-agent-mock";
  status: RunStatus;
  events: AgentEvent[];
  tasks: Task[];
  pendingActions: PendingAction[];     // 驅動審批 UI
  output?: string;
};
