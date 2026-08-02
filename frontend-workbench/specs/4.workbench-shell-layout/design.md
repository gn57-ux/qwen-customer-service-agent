# workbench-shell-layout — 技术设计

## 设计版本

| 日期 | 版本 | 说明 |
| ---- | ---- | ---- |
| 2026-07-31 | v1 | 初始设计 |

## 项目架构

- 架构类型: 多包单仓
- 涉及层: **前端 UI 层**、**前端状态层**
- 不涉及: 服务端（消费 feature 2 产出）、数据库

## 功能模块设计

### 模块 1: 顶栏 `<Header />`

```tsx
<header className="bg-content-bg border-b border-border-color fixed top-0 w-full z-50
                   flex justify-between items-center px-gutter h-16
                   text-text-secondary font-body-md">
```

三组结构（逐字对应 `docs/assets/workbench-stitch.html`）：

| 组 | 内容 |
|---|---|
| 左 | `<h1 className="font-h2 text-h2 font-bold text-text-primary">智修客服</h1>` + 副标题 `font-code text-code text-text-muted border-l border-border-color pl-4 hidden md:inline` |
| 中 | `hidden md:flex gap-6 text-label-sm` 三项状态 |
| 右 | 清空会话按钮 |

**状态点**（§3.3：全局 0 圆角，组件层不写 `rounded-full`）：

```tsx
<span className={`w-2 h-2 block ${dotColor[state]}`} />
```

### 模块 2: 服务状态 Hook

**新文件**: `src/app/hooks/use-service-status.ts`

```ts
type ServiceStatusView = { data: ServiceStatusBody; loading: boolean };

const INITIAL: ServiceStatusBody = {          // ⛔ 初始必须 unknown，不得乐观预设 online
  localModel: "unknown", knowledgeBase: "unknown", orderService: "unknown",
};

export function useServiceStatus() {
  const client = useClient();
  const [data, setData] = useState(INITIAL);

  const refresh = useCallback(async () => {
    try {
      setData(await client.status());
    } catch {
      setData({ localModel: "error", knowledgeBase: "error", orderService: "error" });
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);   // 挂载即探测
  return { data, refresh };
}
```

**关键设计**：`catch` 内**不重新抛出**，直接落为三项 `error`（F-007）。
这样 `status()` 失败永远不会冒泡成未捕获 Promise rejection。

**刷新时机**（F-008）：
- 挂载：`useEffect`
- 对话结束：feature 5 在 `done`/`error` 后调用 `refresh()`
- 手动：点击状态区触发
- 轮询（可选）：`≥30s` + `document.visibilityState === "hidden"` 时暂停

### 模块 3: 状态映射表

```ts
const STATE_LABEL: Record<ServiceState, string> = {
  unknown: "未知", online: "在线", degraded: "降级", error: "异常",
};
const STATE_DOT: Record<ServiceState, string> = {
  unknown: "bg-text-muted",      // #8A94A3
  online:  "bg-success-green",   // #3F7C5F
  degraded:"bg-safety-text",     // #A14D45
  error:   "bg-safety-text",     // #A14D45
};
```

> `degraded` 与 `error` **同色不同文案** —— 这是设计稿既有的取舍（无独立 error 色，
> 需求 §3.1 明确 error 复用 safety 三件套）。文案是二者的唯一区分，故 F-003 要求
> 状态点必须配文字标签，不单靠颜色传达（可访问性要求）。

### 模块 4: 顶栏与聊天 degraded 的关系（易错点）

需求 §6.2 明确：**聊天返回 `degraded: true` 不得直接改写顶栏**。

```
chat done(degraded:true) ──► 右栏显示「降级运行」chip（feature 6）
                        └──► 触发 status.refresh() ──► 顶栏由 status() 结果决定
```

理由：聊天的 `degraded` 描述的是**这一次回答**的链路降级；顶栏描述的是**服务当前**健康度。
二者语义不同，混用会导致一次偶发降级把顶栏永久染红。

### 模块 5: 左栏 `<LeftSidebar />`

```tsx
<aside className="hidden md:flex w-[220px] bg-sidebar-left-bg border-r border-border-color
                  flex-col justify-between p-4 flex-shrink-0 h-full overflow-y-auto no-scrollbar">
```

- `justify-between` 实现「上部列表 / 底部文案」两端对齐
- 会话项激活态：`bg-brand-light-bg text-text-primary border-l-2 border-brand-primary font-bold`
- `truncate` 防止长标题撑破 220px（配合 `flex-shrink-0` 保证宽度不被压缩）

**会话状态**：本期为前端本地 `useState<Session[]>`，无持久化。
`新建会话` 追加一条并置为激活；`清空会话` 清空当前会话消息。

## 接口契约

**消费**（不新增）：

| 来源 | 用途 |
|---|---|
| `client.status()`（feature 2） | 顶栏三项状态 |

## 数据模型

前端本地状态，无持久化：

```ts
interface Session { id: string; title: string; messages: Message[]; }
```

`title` 取该会话首条用户消息的截断文本（设计稿左栏即为问题摘要）。

## 安全考虑

- 顶栏只渲染四态枚举映射后的中文标签，**不**渲染 `status()` 之外的任何信息
- `status()` 的 catch 分支不把 error 对象内容渲染到 UI（避免间接泄露内部地址）
- 会话数据仅存内存，符合左栏「本地运行 · 数据不会离开当前设备」的声明

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 初始状态 | **`unknown`** | 需求 F-005 硬性要求；乐观预设 online 会误导坐席 |
| `status()` 失败处理 | **落为三项 error，不抛出** | 避免未捕获 rejection；对用户表达"探测不到 = 异常" |
| degraded 是否直改顶栏 | **否，改为触发 refresh** | 聊天级降级 ≠ 服务级健康度，混用会永久染红 |
| 状态区分手段 | **颜色 + 文字** | degraded/error 同色，仅靠颜色无法区分；亦满足可访问性 |
| 会话持久化 | **本期不做** | 无后端会话存储；与"数据不离开设备"声明一致 |
| 轮询 | **可选，≥30s 且隐藏时暂停** | 避免无谓探测压垮下游 |
