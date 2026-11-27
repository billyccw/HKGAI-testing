import { type Task } from "../agents.ts"
import { type AgentEvent } from "../multiAgents.ts";

export type RunRecord = {
  runId: number;
  requirementVersion: number;
  requirements: { version: number; text: string; createdAt: string }[];
  tasks: Task[];
  events: AgentEvent[]; 
  status: "running" | "completed" | "blocked" | "cancelled";
  output?: string;
};

export type RunTraceView = {
  id: string;
  mode: "multi-agent-mock";
  status: "running" | "completed" | "blocked" | "cancelled"; // run 的status
  events: AgentEvent[];
  output?: string;
};