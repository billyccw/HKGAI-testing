import { type RunRecord } from "./types.ts";

export interface RunStore {
  getRun(runId: number): Promise<RunRecord | null>;
  saveRun(r: RunRecord): Promise<void>;
}

//測試用的 in-memory store，储存JSON而不是localStorage
export class MemoryRunStore implements RunStore {
  private runs = new Map<number, string>();
  private order: number[] = [];

  async getRunIdList(): Promise<number[]> {
    return [...this.order];
  }

  async getLastRunId(): Promise<number | null> {
    return this.order.at(-1) ?? null;
  }

  async getRun(runId: number): Promise<RunRecord | null> {
    const raw = this.runs.get(runId);
    return raw ? (JSON.parse(raw) as RunRecord) : null;
  }

  async saveRun(r: RunRecord): Promise<void> {
    this.runs.set(r.runId, JSON.stringify(r));
    if (!this.order.includes(r.runId)) this.order.push(r.runId);
  }
}

export class LocalRunStore implements RunStore {
  static runIdListKey = "mindverse:runtime:runIdList";

  async getRunIdList(): Promise<number[]>{
    const runIdList = localStorage.getItem(LocalRunStore.runIdListKey);
    return runIdList ? JSON.parse(runIdList) : [];
  }

  async getLastRunId(): Promise<number | null>{ // 读取localStorage中最后的runId
    const savedRunId = localStorage.getItem(LocalRunStore.runIdListKey);
    if (savedRunId){ 
      const runIdList = JSON.parse(savedRunId)
      const lastRunId = runIdList[runIdList.length - 1]
      return lastRunId ?? null;
    };
    return null;
  }

  async getRun(runId: number): Promise<RunRecord | null> {
    const raw = localStorage.getItem(this.runKey(runId));
    return raw ? (JSON.parse(raw) as RunRecord) : null;
  }

  async saveRunIdList(runId: number): Promise<void>{
    const raw = localStorage.getItem(LocalRunStore.runIdListKey);
    if (!raw) return;
    const runIdList = JSON.parse(raw);
    runIdList.push(runId)
    localStorage.setItem(LocalRunStore.runIdListKey, JSON.stringify(runIdList))
  }

  async saveRun(r: RunRecord): Promise<void> {
    localStorage.setItem(this.runKey(r.runId), JSON.stringify(r));
    const list = await this.getRunIdList();
    if (!list.includes(r.runId)) {
      localStorage.setItem(LocalRunStore.runIdListKey, JSON.stringify([...list, r.runId]));
    }
  }

  public runKey(runId: string | number): string {
    return `mindverse:runtime:run:${runId.toString()}`;
  }

  public reverseKey(fullRunId: string): number {
    return Number(fullRunId.split(":")[fullRunId.length - 1])
  }
}

export function changeRequirement(run: RunRecord, text: string): RunRecord {
  const current = run.requirements.at(-1);
  if (current && current.text.trim() === text.trim()) return run;
  const version = run.requirementVersion + 1;                       // 只此一處 +1
  return {
    ...run,
    requirementVersion: version,
    requirements: [...run.requirements, { version, text, createdAt: "..." }],
    tasks: run.tasks.map(t => ({ ...t, status: "stale" as const })),
  };
}