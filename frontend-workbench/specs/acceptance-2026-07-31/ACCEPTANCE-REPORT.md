# 最终真实全链路验收报告 — 2026-07-31

本报告仅记录本轮验收过程中**实际执行并观察到**的结果。未执行的检查不在此处
声称通过；已执行但发现异常的项，如实记录异常现象与范围判断，不做"淡化"处理。

## 0. 基本信息

- 仓库：`/Users/ruolan/Documents/ai客服`
- 分支：`agent/commercial-training-and-web-guide`
- HEAD：`1d43d4c3523e11a01b773e0ca07525373a994b66`
- 领先 `origin/agent/commercial-training-and-web-guide`（当前分支的远程跟踪
  分支）：**17 commits**（`git status` 原生输出）；另需说明：本分支相对
  `origin/main` 领先 34 commits，这是历史累计差异（含训练/后端阶段的既有
  提交），与本轮"领先远程"应理解为前者（17），特此澄清避免口径混淆
- 验收开始前 `git status`：**clean**（无未提交变更）
- 验收全程（含浏览器场景测试、服务启停）未对任何文件做编辑；结束时
  `git status` 仅新增本报告所在的 `frontend-workbench/specs/
  acceptance-2026-07-31/` 目录（未跟踪），无其他改动
- specs 任务数核实：**8/8 Features，57/57 Tasks**（逐文件核对
  `frontend-workbench/specs/*/tasks.md` 的 `- [x]` 计数，明细见下表，
  不沿用旧版 51/51 统计）

| Feature | 任务数 |
| --- | --- |
| 1.contract-retrieval-counts | 8/8 |
| 2.service-status-endpoint | 8/8 |
| 3.workbench-app-scaffold | 6/6 |
| 4.workbench-shell-layout | 7/7 |
| 5.chat-stream-conversation | 7/7 |
| 6.evidence-panel | 7/7 |
| 7.scenarios-and-degradation | 7/7 |
| 8.quality-gates-and-design-review | 7/7 |
| **合计** | **57/57** |

## 一、服务链启动与身份校验（实际执行结果）

按 Qdrant → Ollama/bge-m3 → Reranker → Mock 订单后端 → llama-server →
FastAPI → Mastra Server → Vite 工作台顺序启动/复用，均使用仓库既有脚本
（`services/start.sh`/`stop.sh`、`services/llama-server-up.sh`、
`mastra-agent/scripts/rerank-up.sh`/`rerank-down.sh`），未使用模糊 `pkill`。

验收结束前最后一次实测（`curl` 直连各服务，非前端代理）：

| 服务 | 状态 | 身份证据 |
| --- | --- | --- |
| Qdrant :6333 | 在线 | `GET /collections` 返回 `customer_service_knowledge` 集合 |
| Ollama bge-m3 :11434 | 在线 | 经 FastAPI/RAG 实测调用返回 1024 维、无 NaN/Infinity 的向量（见 `agent:test:live` 输出） |
| Reranker :8787 | 在线 | `rerank-up.sh` 自带 smoke test：返回 2 条，Top1 index=0 score=-1.0963 |
| Mock 订单后端 :8001 | 在线 | 经 `queryOrderTool` 实测返回 ORD1001 真实字段（见三、场景 3） |
| llama-server :8002 | 在线，真实身份 | 见下方 FastAPI `/health` 输出 |
| FastAPI :8000 | 在线，**真实 llama_cpp backend** | 见下方 |
| Mastra Server :4111 | 在线 | `GET /customer-service/status` 返回三项均 `online` |
| Vite 工作台 :5173 | 在线 | 全程浏览器实测 |

FastAPI `/health` 实测响应（验收末次复核，非缓存）：

```json
{
  "backend": "llama_cpp",
  "status": "ok",
  "upstream_health": true,
  "upstream_identity": true,
  "upstream_identity_detail": "health OK；adapter=customer-service-production-v1-lora.gguf scale=1.0；reasoning_format=none",
  "base_gguf_sha256": "ab7a5d34757a8dc75bc20ef12f6e3ca129c426d31ed0ab79cd4485c9c6797328",
  "adapter_gguf_sha256": "7339a25c754584ba03a824751602f16672ec1435b2f81e8272c0655231022a71",
  "adapter_scale": 1.0,
  "base_revision": "b968826d9c46dd6066d109eabc6255188de91218"
}
```

结论：**backend=llama_cpp（真实推理后端），非 Base-only / Smoke Adapter /
PyTorch-MPS 退化路径**；LoRA scale=1.0；`reasoning_format=none`（reasoning
关闭）；Base/LoRA SHA-256 均已核实并记录在案。

RAG 三件套（Qdrant Collection / bge-m3 Embedding / Reranker）在验收开始时
及各自动化测试（`rag:test`/`rerank:test`/`agent:test:live`）执行期间均为
在线可用状态。**但 Reranker 在本轮验收中被人工主动停止过两次**，用于
专门验证降级 UI 行为（见三节场景 2 专项说明），停止期间 `knowledgeBase`
状态为 `degraded`；每次停止后均已通过 `rerank-up.sh` 重新启动并核实
smoke test 通过后才继续后续测试。因此"三件套全程在线"这一表述不准确，
应理解为"除两次人工诱导的 Reranker 降级窗口外，其余时间均在线"。

服务此前已在运行的部分（本轮开始前已确认在线，非本轮启动）：Qdrant、
Ollama——按用户策略验收结束后予以保留，不停止。

## 二、自动化验收（本轮实测数字，非历史缓存）

| # | 命令 | 结果 |
| - | --- | --- |
| 1 | `cd web-client && npm run gates` | typecheck✅ build✅（含 bundle>500KB 警告，见五）test **161/161 passed**（21 files）gate:no-direct✅ gate:no-hardcoded-count✅ gate:assets✅ |
| 2 | `cd mastra-agent && npm test` | **74/74 passed**（12 suites） |
| 3 | `npm run rag:test`（mastra-agent） | **10/10 passed**（9 suites） |
| 4 | `npm run rerank:test`（mastra-agent） | **25/25 passed**（10 suites） |
| 5 | `npm run agent:test:live`（mastra-agent，对真实下游服务） | **17/17 passed**（2 suites） |
| 6 | `cd web-client && npm run smoke`（对真实 :4111 全链路） | **PASS=39 FAIL=0** |
| 7 | `git diff --check` | 无空白错误，exit=0 |
| 8 | 冻结路径改动扫描 | 本轮验收会话内对仓库跟踪文件**零编辑**（唯一新增是本报告所在的未跟踪目录，非冻结路径）；`services/**`、`datasets/**`、`training/**`、`configs/**`、`knowledge/**`、`models/**` 未被本轮任何操作修改 |
| 9 | 前端 `src` 直连扫描（8000/8001/8002/6333/8787/11434） | 正则扫描 + `gate-no-direct.sh` 均为 0 命中 |
| 10 | 工作区非预期运行时文件检查 | 实测 `git status --porcelain --ignored` 输出：唯一的未跟踪（`??`）条目是本报告所在的新目录；其余均为 `!!`（已忽略）条目，包括 `.venv/`、`mastra-agent/node_modules/`、`web-client/node_modules/`、`models/`、`mastra-agent/.mastra/`、`mastra-agent/.models/`、`mastra-agent/.runtime/`、`services/.runtime/`、多个 `__pycache__/`、`.pytest_cache/`、`knowledge/.DS_Store`、`web-client/dist/`、`codex-review/`、`web-client/codex-review/` 等——均为项目既有 `.gitignore` 规则覆盖的常规产物（依赖安装/构建缓存/本地虚拟环境等），不是本轮验收新产生的非预期文件；本轮实际新增的运行时文件（`.runtime/*.pid`/`*.log`）也全部落在已忽略路径内 |

## 三、真实 UI 场景验收（通过浏览器操作 http://127.0.0.1:5173，非 curl 冒充）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1. 普通问候 | PASS | 不触发 RAG/订单工具（本轮会话内确认，未见执行链路误触发） |
| 2. 冰箱/彩电/显示器维修 | **FAIL（6/6 次实测均复现同一缺陷，0 次成功）** | 见下方专项说明 |
| 3. 订单 ORD1001 | PASS | 调用 `queryOrderTool`；右栏执行链路显示"已识别·订单查询"→"已调用·订单服务"→"已生成"；订单卡真实展示 `订单号 ORD1001 / 状态：已付款，等待仓库发货 / 下单时间 2026-07-21T10:30:00+08:00 / 可取消：是 / 坐席提示`；traceId `trace-ms9iv57a-l9t9n4im`，耗时 3.7s；无字段被编造 |
| 4. 无订单号查询物流 | PASS（此前本轮已测） | 先追问订单号，未调用不存在的订单结果 |
| 5. 多轮 ORD1002→ORD1003 | PASS（此前本轮已测） | 第二轮正确切换订单号，未复用旧结果 |
| 6. 危险维修请求 | PASS（此前本轮已测） | 优先展示安全边界，未提供拆机/带电检测等危险操作建议 |

其他验证项：
- 流式回复：PASS，SSE 增量正常显示
- 取消流式请求：PASS，`smoke` 第 8 项覆盖 + 浏览器手动验证均未见未处理异常
- 顶栏三项状态：PASS，来自真实 `/customer-service/status` 轮询，非乐观预设（初始 `unknown`，人工停止 Reranker 后正确变为"知识库：降级"红点，恢复后正确变回"在线"绿点）
- Reranker 不可用时的 UI 展示：**部分 PASS，见下方缺陷说明**——顶栏状态本身正确反映真实降级（未编造），但降级期间的对话响应存在下述缺陷
- 右栏处理依据（执行链路/回答模式/引用来源/traceId/耗时）：PASS，场景 3/4/5/6 均正确展示
- `retrievedCount`/`returnedCount`：本轮场景中未见硬编码 20/5；但场景 2（唯一会触发该字段展示的场景）6/6 次均未能触发工具调用，故本轮**未在真实 UI 上观察到任何一次具体的 `retrievedCount`/`returnedCount` 数值**——不代表该字段实现有问题（`gate-no-hardcoded-count`/单元测试已从代码层面覆盖该约束），但也不应被理解为"已通过 UI 验证"

### 场景 2 专项说明：维修排查路由的工具跳过 + 复读退化（真实缺陷，非前端问题）

**现象（本轮验收会话中实测的全部维修类请求，共 6 次，6 次均复现，
0 次观察到正常的 RAG 命中展示）**：

1. 二轮对话（"你好" → "冰箱不制冷应该先检查什么"）——**无可追溯 traceId**：
   本轮验收会话曾在压缩（上下文摘要）前观察并描述过此现象，但压缩后
   仅保留了文字摘要，未保留具体 traceId 或原始截图，故本条**仅作为
   本轮验收过程中的既有观察记录，不作为可独立核验的证据**
2. Reranker 已停止（knowledgeBase=degraded）状态下的全新首轮输入
   "彩电屏幕出现闪烁"——**无可追溯 traceId**，理由同上
3. Reranker 已停止状态下的全新首轮输入 "电视开机黑屏，一直没有画面"——
   traceId `trace-ms9irwyu-rpruyvi9`，耗时 24.6s（本轮实测，截图已目测
   核验，但未保存为磁盘文件）
4. Reranker 完全在线（knowledgeBase=online）状态下的全新首轮输入
   "显示器完全没有信号，插上电脑黑屏"——traceId `trace-ms9itm3h-4xqe530m`，
   耗时 24.6s（本轮实测）——证明缺陷与 Reranker 降级状态无必然关联
5. （为复核前一轮报告中"存在正常案例"的表述而补测，Reranker/全链路均
   在线）全新首轮输入 "冰箱冷藏室不制冷了，冷冻室是正常的"——traceId
   `trace-ms9jcqix-su8t9us2`，耗时 26.5s（本轮实测），同样复现
6. （同上目的的第二次补测，全链路在线）全新首轮输入 "冰箱有异味，冷冻室
   结霜严重"——traceId `trace-ms9jdr8i-drsajunh`，耗时 24.4s（本轮实测），
   同样复现，且出现新的症状变体：回复正文中直接**逐字泄漏了工具名
   `searchKnowledgeBase`**（如"我用 searchKnowledgeBase 确认"），而不是
   产生真实的结构化工具调用

**证据留存说明（如实澄清，避免误导审计）**：上述第 3–6 项均记录了本轮
实测的真实 traceId，可用于与 Mastra Server 日志（若仍保留）交叉核对；
第 1–2 项仅为文字回忆，**没有** traceId 或截图支撑，其可信度低于第
3–6 项，读者应据此区别对待。**无论哪一项，本报告都没有把任何截图保存为
磁盘文件**（与四节所述响应式截图缺失是同一工具能力限制）——所有截图均
只在验收过程中被实时查看和目测核验，会话结束后无法再次调取原始图像；
本报告能提供的最强证据是第 3–6 项的 traceId 与本文记录的复读文本节选，
而非可重放的图像证据。

**重要澄清（更正上一版报告的表述）**：上一版报告曾提到"本轮 6 次维修类
请求中 4 次复现、2 次正常"，该"2 次正常"的说法来自本次会话被压缩前的
记忆式描述，本轮补测时**未能重新复现出任何一次正常结果**（新补测的
2 次，即上表第 5、6 项，均复现失败，且均有本轮实测的 traceId 作为
凭证）。因此本报告**不再采信、不再引用**"存在正常案例"这一说法。
本节列出的 6 次实测结果中，第 3–6 项有本轮记录的 traceId 支撑，第 1–2
项仅为文字回忆（无 traceId/截图）——即使保守地只统计有 traceId 支撑的
第 3–6 项，复现率也是 **4/4（100%）**；算上无法独立核验的第 1–2 项，
则为本节所述的 6/6。无论按哪种口径统计，均**不支持**"存在可复现的
正常结果"这一此前的表述，该问题的实际影响范围**很可能比上一版报告
描述得更严重、更具系统性**，而非"罕见的输入特定问题"。

六次复现的共同特征：右栏执行链路**不出现**"已调用·维修知识库"节点（即
`searchKnowledgeBaseTool` 未被实际调用），"引用来源"栏正确显示"本次回答
未引用知识库"（前端诚实呈现，未编造引用）；回复正文进入复读循环（同一句
安全提示重复十余次后中止），第 6 次还观察到工具名被逐字泄漏进正文这一
新变体。

**根因定位**（只读代码审查，未修改任何文件）：
`mastra-agent/src/mastra/orchestration.ts:104-118` 与 `:157-167` 的注释与
实现已明确记录这是已知、预期内的模型/推理层局限：该微调模型经真实请求
验证，`toolChoice:"required"` 对 llama-server 的语义遵守并不 100% 可靠；
代码已按此局限做了显式的"不伪造"兜底——当强制工具调用在第一步仍未产出
真实 tool-call 时，直接返回该步模型的原始文本，不进入第二步合成、不假造
工具结果。本次复现的复读/工具名泄漏现象，正是这条兜底路径下**模型/
llama-server 原始生成本身的退化行为**（重复同一句、疑似 KV-cache/采样
层面的问题，以及模型把工具调用格式当作普通文本生成），而非
`orchestration.ts` 的路由判断错误，也不是前端渲染问题。

**范围判断**：该问题的根因位于微调模型与 llama-server 推理服务
（`services/**`、`models/**`，均为本轮前端改造的冻结范围），且
`orchestration.ts` 对"工具调用未产出"的兜底行为本身是此前已验证、已记录
在案的设计决策，不属于 Feature 1-8 前端范围内的回归缺陷。按用户在本轮
指令中"不重新实现已完成的 Feature 1-8"及冻结路径约束，**本轮未对此进行
修复**，如实记录为已知问题，供后续单独立项处理（例如调整
`services/llama-server-up.sh` 的采样参数、或评估更保守的强制工具调用
重试策略）。鉴于本轮实测复现率为 6/6，**建议将此项优先级从"已知非阻塞
问题"上调为需要在合并前认真评估的问题**（见六、七节）。

**前端侧的正向发现**：在六次复现中，前端组件在收到这种非常规（复读/
工具名泄漏/无工具调用）响应时，浏览器控制台**零报错**，右栏"引用来源"
如实显示"本次回答未引用知识库"而非编造引用或崩溃——这正是
`evidence/derive.ts` 契约驱动设计（不解析 `reply` 正文、只读结构化字段）
预期要防住的失效模式，在真实异常输入下得到了验证。

**样本局限性**：本轮 6 次实测均为维修类请求且均未成功，样本量仍偏小、
且全部来自同一次验收会话的短时间窗口内（同一 llama-server 进程实例），
不能排除该进程实例自身状态（如 KV-cache 累积）导致复现率异常偏高的
可能性；但也没有证据支持"重启 llama-server 后会恢复正常"这一假设——
本轮未做"重启 llama-server 后重测"这一控制变量实验，如需进一步定位
根因，建议后续验收将其列为下一步动作。

## 四、响应式与设计验收

在真实浏览器（`http://localhost:5173`）中实测以下断点，逐项目测：

| 断点 | 布局 | 结果 |
| --- | --- | --- |
| 1920px | 三栏完整（左栏会话列表 / 中间对话 / 右栏处理依据） | PASS，无遮挡/溢出 |
| 1280px | 三栏完整 | PASS，无遮挡/溢出/截断 |
| 1024px | 右栏收进抽屉（"查看处理依据"触发按钮出现），左栏仍常驻 | PASS：点击触发按钮可正确滑出抽屉遮罩层 |
| 375px | 左右栏均收进抽屉（顶部汉堡菜单 + 处理依据齿轮图标），聊天区可正常输入/滚动 | PASS：汉堡菜单可正确滑出会话列表抽屉；输入区未遮挡消息区 |

**已核实**：顶栏 3 个状态点、执行链路节点（本轮场景中实测到"已识别"
"已调用""已生成"等节点，6 类节点未在单次场景中集中触发全部，但代码与
单元测试已覆盖）、输入区 4 个快捷 Chip（冰箱不制冷/电视开机黑屏/显示器
无信号/查询ORD1001）均在页面上确认存在。

**未在本轮完成的验收项（如实说明，不声称已通过）**：
- **未生成可提交的截图文件**：本轮响应式验收通过浏览器工具的实时截图
  完成目测核验（见上表逐项结论），但当前工具集未提供将这些截图保存为
  磁盘文件的手段，因此**未能在 `frontend-workbench/specs/
  acceptance-2026-07-31/` 下生成四档截图文件**。这是工具能力限制，不是
  跳过检查——每个断点均已实际打开、操作并目测确认。
- **19/19 色彩 Token 与 13/13 图标基线的逐项比对**：本轮未执行逐 Token
  数值/逐图标文件的自动化 diff（`gate-assets.sh` 校验的是设计资产文件
  的 SHA-256 完整性，不等同于运行时页面上色值/图标的逐项人工核对）。
  从视觉目测看四个断点均与预期设计一致、无明显色差或图标缺失，但未做
  可追溯的逐项台账，故不在此声称"19/19""13/13"已验证通过。

## 五、Base / QLoRA / QLoRA+RAG / QLoRA+RAG+Tools 证据索引

| 阶段 | 证据 |
| --- | --- |
| Base | `services/manifests/customer-service-production-v1.gguf.json` 记录 base repo `Qwen/Qwen3-8B`、revision `b968826d9c46dd6066d109eabc6255188de91218`；本轮 FastAPI `/health` 的 `base_gguf_sha256` 与之对应 |
| QLoRA | FastAPI `/health` 的 `adapter_gguf_sha256`/`adapter_scale=1.0`；`services/models/gguf-production-v1/summary.md`、`manual-adjudication.md`（既有训练评测报告，本轮未修改） |
| QLoRA+RAG | **本轮未能在真实 UI 上捕获一次成功的 `searchKnowledgeBaseTool` 调用**——本轮 6 次维修类请求（6/6）全部命中三节所述的工具跳过/复读（含工具名泄漏变体）缺陷，没有观察到真实的 `retrievedCount`/`returnedCount`/Rerank 分数展示，此项证据本轮实际**缺失**；`rag:test` 10/10、`rerank:test` 25/25、`agent:test:live` 中的 `searchKnowledgeBaseTool` 相关用例（含真实 Embedding 校验）从组件/集成测试层面验证了检索与重排链路本身工作正常，但这不等同于真实 UI 端到端证据，二者需分开看待 |
| QLoRA+RAG+Tools（订单工具部分） | 场景 3（订单工具）、场景 4/5（订单工具多轮/追问）均在本轮真实复现，`agent:test:live` 17/17 从组件层面验证了强制工具调用链路——**但这只是"QLoRA+Tools"（订单工具）的证据，不构成"QLoRA+RAG+Tools"（同时含检索与工具两种能力）组合场景的证据**，因为这些场景均不涉及 RAG 检索。本轮**没有**一个场景同时验证"检索"与"工具调用"两种能力，"QLoRA+RAG+Tools"组合阶段的真实 UI 证据本轮**缺失**，不应被上一版报告中的订单场景描述所掩盖 |

## 六、已知问题（按影响分级，非全部"非阻塞"）

1. **[需评估，非本轮范围内可修]场景 2 维修路由的工具跳过 + 复读退化，
   本轮实测复现率 6/6**（见三节专项说明）——已定位根因在冻结的模型/
   推理服务层，本轮按范围约束未修复。复现率为 6/6，影响核心 RAG 场景，
   **不属于非阻塞问题**，需在合并前由相关人员评估，详见七节。
2. **[非阻塞]** Vite 生产构建产物 `dist/assets/index-Df3L7ZmX.js` 为
   648.05 kB（gzip 173.88 kB），超过 500 kB 警告阈值；`npm run gates`
   中体现为构建阶段的非阻断性警告，不影响功能。
3. **[非阻塞，验收方法局限]** 响应式验收截图文件未落盘（工具能力限制，
   见四节说明）；色彩 Token/图标的逐项自动化核对未执行，仅完成目测核验。

## 七、Push / Draft PR 条件判断

**不满足**直接 push 或更新 Draft PR 的条件：
- 自动化测试与门禁全部通过、服务身份校验通过、6 类场景中除场景 2 外
  （问候/订单/无订单号追问/多轮切换/危险请求）均完全通过，前端侧本身
  （契约驱动展示、直连扫描、门禁）满足合并前提；
- 但场景 2 暴露的维修路由工具跳过+复读退化本轮实测复现率为 **6/6**，
  是一个**真实存在、高度可复现、导致核心 RAG 场景完全不可用的问题**。
  虽然根因定位在冻结的模型/推理服务层、不属于本轮前端改造范围，但其
  影响面（维修类问答是产品的核心场景之一）足以让"RAG 检索"这一能力
  在当前环境下实质不可用。**强烈建议在 push/合并前**由了解
  llama-server 采样配置、KV-cache 行为的人员专项排查（包括本报告未做的
  "重启 llama-server 后重测"控制变量实验），而不仅是在 PR 描述中声明
  已知限制了事——因为这不是边缘情况，而是本轮验收中该场景的全部样本。

按用户指令，本轮**不执行** push、不合并 main、不发布 Release，停在
Review 点。
