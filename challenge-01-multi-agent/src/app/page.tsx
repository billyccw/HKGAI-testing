"use client";

import { useEffect, useRef, useState } from "react";
import {
  addEdge, Background, BackgroundVariant, Controls, Handle, Position,
  ReactFlow, useEdgesState, useNodesState, useReactFlow,
  type Connection, type NodeProps, type Node, type Edge,
} from "@xyflow/react";
import {
  ArrowDownToLine, ArrowUpFromLine, Bot, Check, ChevronRight, CircleAlert,
  FileText, FolderOpen, ImageIcon, Layers3, LoaderCircle, Moon, Plus,
  Save, Send, Sun, Trash2, Video, X,
} from "lucide-react";
import { initialSnapshot, parseSnapshot, type CanvasNode, type CanvasSnapshot } from "../core/canvas.ts";
import { runMockAgent, type MockAgentTrace } from "../core/mockAgent.ts";
import { startRun, stepRun } from "../core/multiAgents.ts";
import { LocalRunStore } from "../core/runtime/store.ts";
import { type RunRecord, type RunTraceView} from "../core/runtime/types.ts";
import { isInterrupted, cancelRun } from "../core/runtime/recovery.ts";

type EditorNode = Node<CanvasNode["data"], "creative">;
type EditorEdge = Edge;
type AgentMode = "single" | "multi";

const storageKey = "mindverse-challenge:canvas:v1";
const themeKey = "mindverse-challenge:theme";
const agentKey = "mindverse-challenge:canvas:v1:agent";
const store = new LocalRunStore();
const nodeLabels = { text: "文本", image: "图像", video: "视频", reference: "参考" };
const statusLabels = { idle: "未执行", running: "运行中", waiting: "等待中", success: "已完成", error: "失败" };
const phaseLabels = { received: "接收", planning: "整理", tooling: "工具", validating: "校验", completed: "完成", blocked: "阻塞" };
const runStatusLabels = { running: "执行中", completed: "已完成", blocked: "已阻塞", cancelled: "已取消",} as const;
const ROLE_LABELS = { retriever: "检索", composer: "组成", critic: "分工" } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)); // 用于模拟task需要花时间执行
const starter = structuredClone(initialSnapshot);
starter.projectName = "未命名创意项目";
starter.nodes[0].data = { ...starter.nodes[0].data, title: "创意简报", textContent: "安静的摄影棚，同一主体，三个机位。保持场景与主体一致。" };
starter.nodes[1].data = { ...starter.nodes[1].data, title: "场景参考", textContent: "白模构图参考，保留空间关系与主体位置。", imageUrl: "/samples/reference.png" };

function CreativeNode({ id, data, selected }: NodeProps<EditorNode>) {
  const { setNodes } = useReactFlow<EditorNode, EditorEdge>();
  const [imageFailed, setImageFailed] = useState(false);
  const update = (patch: Partial<CanvasNode["data"]>) => setNodes((nodes) => nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
  const Icon = data.nodeType === "text" ? FileText : data.nodeType === "video" ? Video : ImageIcon;
  useEffect(() => setImageFailed(false), [data.imageUrl]);
  return (
    <article className={`creative-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header className="node-heading"><Icon size={15} /><input className="nodrag node-title" aria-label="节点标题" value={data.title} maxLength={120} onChange={(event) => update({ title: event.target.value })} /><span className={`node-status ${data.status}`}>{statusLabels[data.status]}</span></header>
      {data.nodeType !== "text" && <div className="node-media">
        {data.imageUrl && !imageFailed ? <img src={data.imageUrl} alt={data.title} draggable={false} onError={() => setImageFailed(true)} /> : <div className="media-empty"><Icon size={28} strokeWidth={1} /><span>暂无预览</span></div>}
      </div>}
      <textarea className="nodrag nowheel node-text" aria-label="节点内容" value={data.textContent} onChange={(event) => update({ textContent: event.target.value })} />
      <footer className="node-footer"><select className="nodrag" aria-label="节点类型" value={data.nodeType} onChange={(event) => update({ nodeType: event.target.value as CanvasNode["data"]["nodeType"] })}>{Object.entries(nodeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span>{id.slice(0, 12)}</span></footer>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

const nodeTypes = { creative: CreativeNode };

export default function CanvasPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(starter.edges);
  const [projectName, setProjectName] = useState(starter.projectName);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [notice, setNotice] = useState("本地草稿");
  const [instruction, setInstruction] = useState("整理当前画布，列出创意简报和参考素材。");
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [trace, setTrace] = useState<MockAgentTrace | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSequence = useRef(0);
  const cancelRef = useRef(false);
  const [agentMode, setAgentMode] = useState<AgentMode>("single");
  const [multiTrace, setMultiTrace] = useState<RunTraceView | null>(null);
  const [boardOpen, setBoardOpen] = useState(true);
  const [pendingRecovery, setPendingRecovery] = useState<RunRecord | null>(null);
  const drivingRef = useRef(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(themeKey);
      const next = saved === "dark" ? "dark" : "light";
      setTheme(next);
      document.documentElement.dataset.theme = next;
      // 开局读取过往的agent是单还是多
      const savedAgent = localStorage.getItem(agentKey);
      const nextAgent = savedAgent === "multi" ? "multi" : "single";
      if (nextAgent == "multi") setInstruction("将创意简报拆开成三个机位");
      setAgentMode(nextAgent);
      // 开局读取run id，如果有run过就还原最后一次的run 的trace，如果最近一次run还是running就代表需要中断恢复
      (async () => {
        const lastRunId = await store.getLastRunId();
        if (lastRunId == null) return;
        const run = await store.getRun(lastRunId);
        if (!run) return;
        if (isInterrupted(run)) {
          setPendingRecovery(run);
        }
        setMultiTrace(toTrace(run));        // 仍顯示既有事件，讓使用者看到中斷在哪
      })();
    } catch { setNotice("浏览器存储不可用，仍可导出 JSON"); }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const snapshot = (): CanvasSnapshot => parseSnapshot({ version: 1, projectName, nodes, edges });
  const restore = (value: unknown) => {
    const restored = parseSnapshot(value);
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setProjectName(restored.projectName);
  };
  const act = (operation: () => void) => {
    try { operation(); } catch { setNotice("操作失败：文件结构无效或本地存储不可用"); }
  };
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    setEdges((current) => addEdge({ ...connection, id: crypto.randomUUID() }, current));
  };
  const addNode = () => setNodes((current) => [...current, {
    id: crypto.randomUUID(), type: "creative", position: { x: 100 + (current.length % 4) * 65, y: 120 + (current.length % 5) * 85 },
    data: { nodeType: "text", title: "新建文本", textContent: "", status: "idle" },
  }]);
  const deleteSelected = () => {
    const deleted = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    setNodes((current) => current.filter((node) => !deleted.has(node.id)));
    setEdges((current) => current.filter((edge) => !edge.selected && !deleted.has(edge.source) && !deleted.has(edge.target)));
  };
  const save = () => act(() => { localStorage.setItem(storageKey, JSON.stringify(snapshot())); setNotice("已保存到此浏览器"); });
  const load = () => act(() => {
    const saved = localStorage.getItem(storageKey);
    if (!saved) { setNotice("此浏览器暂无存档"); return; }
    restore(JSON.parse(saved)); setNotice("已载入本地存档");
  });
  const exportJson = () => act(() => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "mindverse-canvas.json"; anchor.click();
    URL.revokeObjectURL(url); setNotice("已导出画布 JSON");
  });
  const importJson = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setNotice("导入失败：文件不能超过 2 MB"); return; }
    try { restore(JSON.parse(await file.text())); setNotice("已导入并校验画布"); }
    catch { setNotice("导入失败：请检查 JSON、节点与连线结构"); }
  };
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next); document.documentElement.dataset.theme = next;
    act(() => localStorage.setItem(themeKey, next));
  };
  const toggleAgent = () => {
    const next = agentMode === "single" ? "multi" : "single";
    setAgentMode(next); 
    setInstruction(next === "multi" ? "将创意简报拆开成三个机位": "整理当前画布，列出创意简报和参考素材。");
    act(() => localStorage.setItem(agentKey, next));
  };
  const run = () => {
    if (busy) return;
    const result = runMockAgent({ runId: `mock-${++runSequence.current}`, instruction, snapshot: { version: 1, projectName, nodes, edges }, simulateFailure });
    setTrace(null); setBusy(true);
    timer.current = setTimeout(() => { setTrace(result); setBusy(false); timer.current = null; }, 350);
  };
  const cancel = () => {
    cancelRef.current = true; // 设置multi agent的停止
    if (timer.current) { // 设置单agent的停止
      clearTimeout(timer.current);
      timer.current = null;
      setBusy(false);
      setNotice("已停止本次模拟展示");
      return;
    }
  };

  /**
   * 由page全权控制multi agent的run，这样才能透过逐个event的出现看到task之间的依赖和并行
   * 唯一的推進迴圈。新 run 與續跑共用，差別只在傳進來的 start()。
   * busy / 取消 / 落盤 / UI 更新集中在這裡，避免兩份迴圈各自演化。
   */

  const drive = async (start: () => Promise<RunRecord>) => {
    if (drivingRef.current) return;
    drivingRef.current = true;
    cancelRef.current = false;
    setBusy(true);
    try {
      const run = await start();
      applyRun(run);
      if (run.status !== "running") return;
      while (!cancelRef.current) {
        const more = await stepRun(run, { onProgress: applyRun });
        await store.saveRun(run);        // 唯一的落盤點：輪邊界
        applyRun(run);
        if (!more) break;
        await sleep(120);
      }
      if (run.status === "running" && cancelRef.current) { // run还在running但使用者主動中止
        cancelRun(run, "用户中止本次执行");
        await store.saveRun(run);
        applyRun(run);
      }
    } catch {
      setNotice("多 Agent 模拟失败");
    } finally {
      drivingRef.current = false;
      setBusy(false);
    }
  };

  const runMulti = () => { //开启新multi agent的run
    if (pendingRecovery) return;
    void drive(async () => {
      setMultiTrace(null);
      const runId = ((await store.getLastRunId()) ?? 0) + 1;
      return startRun(
        { runId, instruction, snapshot: { version: 1, projectName, nodes, edges }, simulateFailure },
        store,
      );
    });
  };

  const resumeRun = () => { // 恢复已有被中断的run
    const run = pendingRecovery;
    if (!run) return;
    setPendingRecovery(null);
    void drive(async () => run); 
  };

  const discardRun = async () => { // 撤销已有被中断的run
    const run = pendingRecovery;
    if (!run) return;
    cancelRun(run, "检测到执行中断；用户放弃恢复"); 
    await store.saveRun(run);   
    applyRun(run);          // 展示被取消的run的trace
    setPendingRecovery(null);
  };

  const applyRun = (run: RunRecord) => setMultiTrace(toTrace(run));
  const toTrace = (run: RunRecord): RunTraceView => ({ // 将已有的run转化为可视化trace
    id: `MultiMock-${run.runId}`,
    mode: "multi-agent-mock",
    status: run.status,
    events: [...run.events],
    tasks: run.tasks.map((t) => ({ ...t, outputRefs: [...t.outputRefs] })),
    ...(run.output ? { output: run.output } : {}),
  });

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand"><Layers3 size={22} strokeWidth={1.6} /><strong>Mindverse</strong></div>
        <ChevronRight className="breadcrumb" size={14} />
        <input className="project-name" aria-label="项目名称" value={projectName} maxLength={100} onChange={(event) => setProjectName(event.target.value)} />
        <span className="challenge-tag">运行时挑战 / 01</span>
        <div className="top-actions">
          <button className="icon-button" title="保存到浏览器" aria-label="保存到浏览器" onClick={save}><Save size={17} /></button>
          <button className="icon-button" title="载入本地存档" aria-label="载入本地存档" onClick={load}><FolderOpen size={17} /></button>
          <span className="divider" />
          <button className="icon-button" title="导出 JSON" aria-label="导出 JSON" onClick={exportJson}><ArrowDownToLine size={17} /></button>
          <button className="icon-button" title="导入 JSON" aria-label="导入 JSON" onClick={() => fileInput.current?.click()}><ArrowUpFromLine size={17} /></button>
          <button className="icon-button" title={theme === "light" ? "切换深色主题" : "切换浅色主题"} aria-label={theme === "light" ? "切换深色主题" : "切换浅色主题"} onClick={toggleTheme}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          <button className="icon-button" disabled={busy} title={busy ? "任务执行中，请待结束再切换" : agentMode === "single" ? "切换到多 Agent" : "切换到单 Agent"} aria-label={agentMode === "single" ? "切换到多 Agent" : "切换到单 Agent"} onClick={toggleAgent}>{agentMode === "single" ? "单" : "多"}</button>
        </div>
        <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={(event) => { void importJson(event.target.files?.[0]); event.target.value = ""; }} />
      </header>

      <div className="workspace-body">
        <section className="canvas-area" aria-label="创意画布">
          <div className="canvas-toolbar"><button className="primary-button" onClick={addNode}><Plus size={16} />添加节点</button><button className="icon-button" title="删除选中节点或连线" aria-label="删除选中节点或连线" disabled={!nodes.some((node) => node.selected) && !edges.some((edge) => edge.selected)} onClick={deleteSelected}><Trash2 size={16} /></button></div>
          <ReactFlow<EditorNode, EditorEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} isValidConnection={(connection) => connection.source !== connection.target} fitView fitViewOptions={{ padding: 0.18, maxZoom: 1 }} minZoom={0.2} maxZoom={2} colorMode={theme} deleteKeyCode={["Backspace", "Delete"]} defaultEdgeOptions={{ type: "smoothstep" }}>
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <div className="canvas-status"><span>{nodes.length} 个节点 · {edges.length} 条连接</span><span role="status">{notice}</span></div>
        {agentMode === "multi" && multiTrace && multiTrace.tasks.length > 0 && (
          <aside className={`task-float ${boardOpen ? "" : "collapsed"}`} aria-label="任务看板">
            <div className="task-float-head">
              <strong>任务看板</strong>
              <small>
                {multiTrace.tasks.filter((t) => t.status === "running").length} 运行 ·{" "}
                {multiTrace.tasks.filter((t) => t.status === "done").length}/{multiTrace.tasks.length} 完成
              </small>
              <button
                type="button"
                onClick={() => setBoardOpen((v) => !v)}
                aria-label={boardOpen ? "收起任务看板" : "展开任务看板"}
              >
                {boardOpen ? "−" : "+"}
              </button>
            </div>
            {boardOpen && (
              <div className="task-list">
                <div className="task-row task-head">
                  <span>任务</span>
                  <span>角色</span>
                  <span>状态</span>
                  <span>产物</span>
                  <span>依赖</span>
                </div>
                {multiTrace.tasks.map((t) => (
                  <div key={t.id} className={`task-row task-${t.status}`}>
                    <code>{t.id}</code>
                    <span>{ROLE_LABELS[t.role]}</span>
                    <span className="task-status">{t.status}</span>
                    <span className="task-out">{t.outputRefs.length || "—"}</span>
                    <span className="task-deps">{t.dependsOn.length ? `← ${t.dependsOn.join(", ")}` : "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
        </section>

        {agentMode === "single" ? (
          <aside className="agent-panel" aria-label="Agent 任务面板">
            <header className="panel-heading"><Bot size={19} /><h1>Agent</h1><span className="mode-badge">单 Agent · Mock</span></header>
            <div className="agent-scroll">
              <div className="session-heading"><span className="tiny-dot" />本地任务会话</div>
              <h2>画布整理助手</h2>
              <div className="runtime-facts"><span>模型 <b>未连接</b></span><span>工具 <b>本地模拟</b></span></div>
              {!trace && !busy && <div className="empty-run"><Layers3 size={32} strokeWidth={1} /><span>暂无运行记录</span></div>}
              {busy && <div className="running-state" role="status"><LoaderCircle size={18} className="spinning" />正在执行本地模拟…</div>}
              {trace && <section className="run-record" aria-label="运行记录">
                <div className="run-summary"><span>{trace.id}</span><strong className={trace.status === "blocked" ? "error-text" : ""}>{trace.status === "completed" ? "已完成" : "已阻塞"}</strong></div>                
                <ol className="event-list">{trace.events.map((event) => <li key={event.id}>
                  <span className={`event-icon ${event.kind === "error" ? "error-text" : ""}`}>{event.kind === "error" ? <CircleAlert size={14} /> : <Check size={14} />}</span>
                  <div><span className="event-phase">{phaseLabels[event.phase]}</span><p>{event.message}</p>{event.metadata?.tool && <code>{String(event.metadata.tool)}</code>}</div>
                </li>)}</ol>
                {trace.output && <div className="agent-output"><div><FileText size={14} />运行结果</div><p>{trace.output}</p></div>}
              </section>}
            </div>
            <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); run(); }}>
              <label className="failure-toggle"><input type="checkbox" checked={simulateFailure} disabled={busy} onChange={(event) => setSimulateFailure(event.target.checked)} />模拟工具失败</label>
              <div className="composer-field"><textarea aria-label="任务指令" placeholder="输入任务…" value={instruction} maxLength={2000} disabled={busy} onChange={(event) => setInstruction(event.target.value)} /><div className="composer-footer"><span>{instruction.length} / 2000</span>{busy ? <button className="send-button" type="button" title="停止本次模拟" aria-label="停止本次模拟" onClick={cancel}><X size={16} /></button> : <button className="send-button" type="submit" title="运行单 Agent 模拟" aria-label="运行单 Agent 模拟" disabled={!instruction.trim()}><Send size={16} /></button>}</div></div>
            </form>
          </aside>
        ) : (
          <aside className="agent-panel" aria-label="多 Agent 任务面板">
            <header className="panel-heading"><Bot size={19} /><h1>Agent</h1><span className="mode-badge">多 Agent · Mock</span></header>
            <div className="agent-scroll">
              <div className="session-heading"><span className="tiny-dot" />本地任务会话</div>
              <h2>多Agent画布拆分助手</h2>
              <div className="runtime-facts"><span>模型 <b>未连接</b></span><span>工具 <b>本地模拟</b></span></div>
              {!multiTrace && !busy && <div className="empty-run"><Layers3 size={32} strokeWidth={1} /><span>暂无运行记录</span></div>}
              {busy && <div className="running-state" role="status"><LoaderCircle size={18} className="spinning" />正在执行多 Agent 模拟…</div>}
              {multiTrace && <section className="run-record" aria-label="多 Agent 运行记录">
                <div className="run-summary">
                  <span>{multiTrace.id}</span>
                  <strong className={pendingRecovery || multiTrace.status === "blocked" ? "error-text" : ""}>
                    {pendingRecovery ? "已中断（待决定）" : runStatusLabels[multiTrace.status]}
                  </strong>
                </div>
                <ol className="event-list">{multiTrace.events.map((event) => <li key={event.id}>
                  <span className={`event-icon ${event.kind === "error" ? "error-text" : ""}`}>{event.kind === "error" ? <CircleAlert size={14} /> : <Check size={14} />}</span>
                  <div><span className="event-phase">{phaseLabels[event.phase]}</span><p>{event.message}</p>{event.metadata?.tool && <code>{String(event.metadata.tool)}</code>}</div>
                </li>)}</ol>
                {multiTrace.output && <div className="agent-output"><div><FileText size={14} />运行结果</div><p>{multiTrace.output}</p></div>}
              </section>}
            </div>
            {pendingRecovery ? (
              <div className="recovery-prompt" role="alertdialog" aria-label="恢复上一次执行">
                <p>检测到上一次执行意外中断（{toTrace(pendingRecovery).id}）。</p>
                <p>
                  已完成 {pendingRecovery.tasks.filter((t) => t.status === "done").length} 个任务，
                  还有 {pendingRecovery.tasks.filter((t) => t.status !== "done").length} 个未完成。
                  要继续执行，还是放弃并取消剩余任务？
                </p>
                <div className="recovery-actions">
                  <button type="button" className="primary-button" onClick={resumeRun}>继续执行</button>
                  <button type="button" className="ghost-button" onClick={() => void discardRun()}>放弃本次</button>
                </div>
              </div>
            ) : (
              <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); runMulti(); }}>
                <label className="failure-toggle"><input type="checkbox" checked={simulateFailure} disabled={busy} onChange={(event) => setSimulateFailure(event.target.checked)} />模拟工具失败</label>
                <div className="composer-field"><textarea aria-label="任务指令" placeholder="输入任务…" value={instruction} maxLength={2000} disabled={busy} onChange={(event) => setInstruction(event.target.value)} /><div className="composer-footer"><span>{instruction.length} / 2000</span>{busy ? <button className="send-button" type="button" title="停止本次模拟" aria-label="停止本次模拟" onClick={cancel}><X size={16} /></button> : <button className="send-button" type="submit" title="运行多 Agent 模拟" aria-label="运行多 Agent 模拟" disabled={!instruction.trim()}><Send size={16} /></button>}</div></div>
              </form>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}