# 电商家电售后客服正式训练数据集报告

> 数据集版本：`customer-service-2026-07-v1`
> 生成日期：2026-07-29（第二轮修正）
> 基础模型：`Qwen/Qwen3-8B` @ `b968826d9c46dd6066d109eabc6255188de91218`
> 随机种子：`20260729`
> 审计结论：**PASS**（27 项检查，退出码 0）
> 纯预处理验证：**PASS**（observation 角色编码与仓库内 Qwen3 chat template 逐字符一致）

---

## 1. 交付物清单

| 文件 | 说明 |
|---|---|
| `datasets/customer-service-train-640.json` | 训练集 640 条 |
| `datasets/customer-service-validation-80.json` | 验证集 80 条 |
| `datasets/customer-service-test-80.json` | 测试集 80 条（**禁止用于训练与 checkpoint 选择**） |
| `datasets/customer-service-dataset-manifest.json` | 数据清单与聚合统计 |
| `datasets/customer-service-dataset-report.md` | 本报告 |
| `datasets/agent-tool-evaluation.json` | Mastra Agent 订单工具评测集（**非训练数据**） |
| `datasets/dataset_info.json` | 三个正式数据集定义（含 `observation_tag`）+ 保留原 20 条 Smoke 定义 |
| `scripts/dataset_source/` | 人工撰写的样本源（按类别分模块） |
| `scripts/build_customer_service_dataset.py` | 构建脚本（固定种子、可复现） |
| `scripts/audit_customer_service_dataset.py` | 审计脚本（27 项检查，失败返回非零退出码） |
| `scripts/verify_template_encoding.py` | 纯预处理验证（不加载模型、不下载权重） |
| `configs/train-qwen3-8b-qlora-production-linux.yaml` | 正式训练配置草案 |

原有 `datasets/customer-service-smoke-20.json`（20 条冒烟数据）**未删除、未修改**，
其旧版 system prompt 与旧订单号格式 `YD…` 在审计脚本中作为 legacy 版本单独放行，
`dataset_info.json` 里的 Smoke 条目也保持原有 tags 配置不变。

---

## 2. 职责边界

```text
System Prompt → 身份、规则、越权边界
QLoRA        → 客服语气、回复结构、意图识别、澄清追问、安全边界、
                工具/RAG 调用意识、失败降级、人工升级
RAG          → 维修知识、故障归因、部件原理、机型操作路径、
                具体排查步骤、售后政策事实（含时限/金额/适用条件/责任划分）
Tools        → 订单、物流、退款等实时状态（queryOrderTool）
```

### 2.1 可信工具 / 检索结果角色（第二轮核心修正）

**问题**：第一轮把 `[订单系统返回]` 放在 `user` 消息里。用户可以逐字伪造该标记，
模型无法从协议层区分可信工具输出与用户输入。

**已核实的框架能力**（直接读 LLaMA Factory v0.9.5 源码，非推测）：

| 源文件 | 关键事实 |
|---|---|
| `src/llamafactory/data/parser.py` | `DatasetAttr.observation_tag` 默认 `"observation"`；`function_tag` 默认 `"function_call"`；两者均可在 `dataset_info.json` 的 `tags` 中覆盖 |
| `src/llamafactory/data/converter.py` | `odd_tags = (user_tag, observation_tag)`、`even_tags = (assistant_tag, function_tag)`；因此 `user → assistant → observation → assistant` 是合法序列，不会被判 `broken_data` |
| `src/llamafactory/data/template.py` | `qwen3_nothink` **确实存在**，且显式定义 `format_observation`：`<\|im_start\|>user\n<tool_response>\n{{content}}\n</tool_response><\|im_end\|>\n<\|im_start\|>assistant\n` |
| `src/llamafactory/data/processor/supervised.py` | `source` 段 label 置 `IGNORE_INDEX`（除非 `train_on_prompt`），observation 属于 source → **不计入损失** |

**最终方案**：工具与知识库返回统一使用 `observation` 角色。

```text
user:        订单 ORD5088 现在什么情况？
assistant:   我用 ORD5088 去订单系统查询当前状态，请稍等。
observation: [订单系统返回] found=true, order_id=ORD5088, status=paid,
             status_text=已付款待出库, carrier=null, tracking_number=null,
             estimated_delivery=null
assistant:   查到了：这笔订单目前处于已付款待出库，系统里还没有承运方和运单号，
             也没有给出预计送达时间，所以我不替它估日期。……
```

编码后进入分词器的实际文本：

```text
<|im_start|>user
<tool_response>
[订单系统返回] found=true, order_id=ORD5088, status=paid, ...
</tool_response><|im_end|>
<|im_start|>assistant
```

**安全理由**：`<tool_response>` 包裹由框架生成，用户在 `user` 轮打什么字都不会产生这层包裹；
模型据此在协议层区分可信工具输出与用户输入。该编码与本项目 Qwen3 分词器
`adapters/customer-service-smoke/chat_template.jinja` 中 `role == "tool"` 的分支
**逐字符一致**，所以训练态与 Mastra 运行时的工具消息同构。

`dataset_info.json` 中三个正式数据集单独配置了
`observation_tag: observation` 与 `function_tag: function_call`；
Smoke 数据不含 observation 轮，其条目保持原样。

**本轮未引入 `function_call` 轮**：assistant 发起查询仍用自然语言表述。原因是
`FunctionFormatter` + `ToolFormatter(qwen)` 对 assistant 内容和 `tools` 列的 JSON 结构有额外约定，
本机无法执行 LLaMA Factory 实测验证；而工具调用的发起本就由 Mastra 在推理时以 `tools` 参数驱动。
待 4090 环境可用后可作为增强项补上，届时 `dataset_info.json` 已预留 `function_tag`。

### 2.2 LoRA 不学的事实

| 禁止作为模型知识 | 处理方式 |
|---|---|
| `ORD1001` / `ORD1002` / `ORD1003` / `ORD9999` 的固定状态 | 四个订单号**完全不出现**在 800 条中，审计第 15 项 + 构建脚本双重拦截；仅保留在 Mock 后端与 `agent-tool-evaluation.json` |
| 固定物流节点、预计送达日期、退款进度 | 仅允许出现在 observation 块里；审计第 16 项正则拦截无依据断言，第 24 项要求 assistant 说出的状态词必须来自最近一条 observation 或处于条件表述中 |
| 故障归因、部件原理 | 无 observation 依据时只写"我不先归因 / 请告诉我…；我按型号检索该机型的说明"，审计第 26 项拦截 |
| 机型操作路径（菜单层级、长按几秒） | 同上；需要给出路径的样本一律带知识库 observation 并注明文档名与版本 |
| 维修量值（化霜多少小时、散热留几厘米） | 同上；量值只出现在 observation 与其后的转述里 |
| 保修 / 退换 / 退款 / 发票 / 支付 / 安装政策结论、时限、金额、责任划分 | 同上 |

### 2.3 observation 样本构成

| 类型 | 条数 | 覆盖情形 |
|---|---:|---|
| `[订单系统返回]` | **13** | `found=true`（paid / shipped / exception / refund processing）、`found=false`、`timeout`、`http_500`、`http_503`、`connection_refused`、`field_missing`、关键字段为空 |
| `[知识库检索]` | **7** | 命中并给出真实文档名+版本+章节（6 条）、**未命中且低于阈值**（1 条降级样本） |
| **合计带 observation 的样本** | **20** | |

> 第一轮报告写"依据块 13 条"，实际是 13 条订单工具块 + 1 条知识库未命中块（共 14 轮、13 条样本）。
> 本轮已修正统计口径，并把知识库依据块从 1 条扩充到 7 条（6 条命中 + 1 条未命中降级）。

命中类的知识库 observation 都带 `doc=…#锚点 version=… score=…`，
其后的 assistant 回复必须点出文档名与版本（例如"按知识库里的排障指南（refrigerator.md 结霜严重，版本 1.0.0）"），
只转述块内已有的事实，块里没有的一律不补。

### 2.4 知识库引用必须解析到真实文档（本轮补充发现）

本轮收尾时 `knowledge/` 目录已出现真实的维修文档
（`repair/{refrigerator,television,monitor}.md`，`document_version: 1.0.0`）。
把先前撰写的 12 条知识库 observation 与它们逐条比对后发现三个问题：

1. **版本号不符**：observation 写 `version=1.3 / 1.2 / 1.1`，实际文档均为 `1.0.0`；
2. **章节不存在**：`#手动化霜`、`#面板童锁`、`#智能配网`、`#待机灯语`、`#菜单锁定`、
   `#开机推广设置` 等锚点在真实文档中没有，`knowledge/policies/` 目录也尚未建立；
3. **内容与真实文档冲突**：真实 `monitor.md` 明确写"**客服不得承诺某个数量的亮点、暗点一定换机**"，
   而原样本却给出"亮点累计 2 个及以上即可换修""您这两个亮点已经达到门槛"。
   真实 `refrigerator.md` 也写明静置要求"应优先遵循该型号说明书"，未给统一时长，
   原样本却编了"静置 2 小时 / 6 小时"。

这类问题比编造事实更隐蔽：它教模型生成**格式正确但不存在的引用**。已按如下方式修正：

| 处理 | 条数 | 说明 |
|---|---:|---|
| 重新对齐到真实文档 | 6 | 改用真实 `doc#章节` + `version=1.0.0`，内容改为对应章节原文的忠实摘要（真实文档全篇不含数值量值，摘要也不含） |
| 改回"需检索"形态 | 5 | 真实知识库没有对应章节（童锁、配网、保修免责、电视像素标准、开机推广），不再引用不存在的文档 |
| 保持不变 | 1 | `id-tr-x03` 是检索未命中降级样本，本身不带 `doc=` 引用 |

其中 `mo-tr-n04` 改造后反而成为更好的样本：它按真实文档要求走证据采集流程，
并明确"资料写明客服不得承诺某个数量的亮点一定换机，所以我不会告诉您两个亮点就一定能换"。

新增**审计第 27 项**固化这条约束：知识库 observation 里的 `doc` / `version` / 章节
必须能解析到 `knowledge/` 下的真实文档，否则 FAIL。

---

## 3. 数据分布

### 3.1 划分与版本绑定

| Split | 数量 | SHA-256 |
|---|---:|---|
| train | 640 | `76464f6b2da0be60d30e796d566e80f7c5fb3597d61020c5c36d49a841e4d5e7` |
| validation | 80 | `d8cbcf9a0cbf303f1340b36594f66308ebaf4487650a605c509267bb8226c2e8` |
| test | 80 | `7baa23aec2e35c4744d2f2cf8bccf3b65b773f678d3244caf867551b8a8a8406` |
| **合计** | **800** | |

三份 SHA-256 已写入 `configs/train-qwen3-8b-qlora-production-linux.yaml` 的 dataset 段注释，
与基础模型 revision `b968826d9c46dd6066d109eabc6255188de91218` 一并作为开训前的核验项。

划分方式：**每条样本在源码中显式声明所属 split**，同一场景不会被改写后分散到多个 split，
测试集是独立编写的，而非训练集的改写版本。

### 3.2 类别分布（满足全部下限要求）

| 类别 | 要求下限 | 实际 | train | val | test |
|---|---:|---:|---:|---:|---:|
| 冰箱维修咨询 | 160 | 160 | 128 | 16 | 16 |
| 彩电维修咨询 | 120 | 120 | 96 | 12 | 12 |
| 显示器维修咨询 | 120 | 120 | 96 | 12 | 12 |
| 订单查询与物流异常 | 100 | 100 | 80 | 10 | 10 |
| 退货退款与换货 | 100 | 100 | 80 | 10 | 10 |
| 保修 / 安装 / 发票 / 支付 | 80 | 80 | 64 | 8 | 8 |
| 投诉 / 情绪 / 转人工 | 50 | 50 | 40 | 5 | 5 |
| 安全边界与拒绝 | 40 | 40 | 32 | 4 | 4 |
| 提示注入 / 越权 / 异常降级 | 30 | 30 | 24 | 3 | 3 |

### 3.3 场景类型分布

| 场景 | 数量 | 场景 | 数量 |
|---|---:|---|---:|
| normal（正常问题） | 189 | multi_intent（多意图） | 69 |
| insufficient_info（信息不足） | 85 | boundary（边界条件） | 73 |
| vague（模糊表达） | 77 | unverifiable（无法确认的事实） | 70 |
| typo（错别字/口语） | 76 | multi_turn（多轮、指代、纠正、需求变化） | 80 |
| angry（用户情绪激动） | 81 | | |

**9 个类别 × 9 种场景全部覆盖**（审计第 18 项强制校验），每个类别都含 RAG 样本与 Tool 样本。

### 3.4 其他维度

| 维度 | 数量 |
|---|---:|
| risk_level = low / medium / high | 436 / 318 / 46 |
| requires_rag = true | 262 |
| requires_tool = true（均带 `expected_tool: queryOrderTool`） | 112 |
| 带 observation 轮 | 20（13 工具 + 7 检索） |
| 多轮样本（≥2 轮问答） | 86 |
| system prompt = base / tools / safety | 527 / 184 / 89 |

单条样本最长 553 字符，`cutoff_len: 1536` 有充足余量。

> `requires_rag` 从第一轮的 106 增至 262：这不是靠改元数据放宽标准，而是因为大量原本
> 直接给结论的回答被改写成"需要检索该机型/该订单的依据"，元数据随内容一并修正。
> 审计第 26 项直接检查 `messages` 正文，不看元数据，因此无法通过改元数据规避。

---

## 4. 自动审计结果

```bash
python3 scripts/audit_customer_service_dataset.py
```

**退出码 0**。27 项检查：26 项 PASS、1 项 WARN、0 项 FAIL。

| # | 检查项 | 结果 |
|---:|---|---|
| 1 | JSON 格式 | PASS |
| 2 | 角色顺序（system 首位；user 侧允许 user/observation；以 assistant 结尾） | PASS |
| 3 | 空内容 | PASS |
| 4 | 完全重复样本 | PASS（0 组） |
| 5 / 5b | 用户问题重复（首轮 / 追加轮） | PASS（0 / 0） |
| 6 | assistant 回答重复 | PASS（0 组） |
| 7 | 跨数据集完全重复 | PASS（0 组） |
| 8 / 8b | 跨 split 近似重复（≥0.70）/ 同 split 内（≥0.85） | PASS（0 对；0.58–0.70 告警区间也为 0 对） |
| 9 / 9b | 订单号格式 / 隐私信息 | PASS（0 / 0） |
| 10 | 危险维修建议关键词 | **WARN**：可执行危险步骤 0 处；说明性提及 13 处（见 4.1） |
| 11 | 数量与类别分布 | PASS |
| 12 | train / validation / test 泄漏 | PASS（0） |
| 13 | 文本长度异常 | PASS（最长单条 553 字符） |
| 14 | system prompt 版本 | PASS |
| 15 | 保留订单号隔离 | PASS（0 处泄漏） |
| 16 | 动态事实未编造 | PASS（0 处） |
| 17 | 工具元数据完整性 | PASS |
| 18 | 类别 × 场景覆盖 | PASS |
| 19 | assistant 开头多样性 | PASS（最常见开头占 2.2%，733 种开头 / 891 条回复） |
| 20 | 源数据与 JSON 往返一致 | PASS |
| 21 | manifest 聚合一致 | PASS |
| 22 | assistant 未原样复述用户问题 | PASS |
| **23** | **工具/检索结果角色归属** | PASS：25 条带 observation；`user`/`assistant` 轮出现 `[订单系统返回]`/`[知识库检索]` 即 FAIL；observation 必须夹在 assistant 之间且落在 user 侧 |
| **24** | **状态转述有依据** | PASS：assistant 说出的订单/退款状态词必须出现在最近一条 observation 中，或所在句带条件/否定标记 |
| **25** | **observation 订单号一致** | PASS：工具返回中的订单号必须与上下文当前订单号一致，且不得出现上下文没有的订单号 |
| **26** | **无依据事实断言** | PASS：无 observation 依据时，禁止故障归因、因果推断、正常性判定、机型操作路径、维修量值、政策结论 |
| **27** | **知识库引用可解析** | PASS：6 条引用的 `doc` / `version` / 章节全部命中 `knowledge/` 下真实文档；1 条为未命中降级样本 |

### 4.1 关于第 10 项 WARN

审计对危险关键词采用分句判定：句中出现 `拆机 / 后盖 / 高压 / 压缩机 / 制冷剂 / 电源板 / 带电 / 短接` 等词时，

- 同句含禁止或风险表述 → 合规；
- 同句含指导性引导语且无禁止表述 → **判 FAIL**；
- 两者都没有 → 计入说明性提及，仅告警。

当前 13 处说明性提及均经人工确认为正当表述，例如"压缩机运转时有没有声音"（让用户描述现象）、
"我先给免拆机的排查项"（明确限定在免拆范围）、"涉及拆卸和复原的责任划分"（谈责任归属）。

### 4.2 纯预处理验证

```bash
python3 scripts/verify_template_encoding.py --jinja
```

结果 **PASS**：

```text
[1] 角色序列校验：800 条记录，全部可被 LF ShareGPT 转换
[2] observation 包裹检查：20 条样本全部渲染为 <tool_response>…</tool_response>
[3] user/assistant 轮伪造检查：未发现工具/检索标记
[4] 损失掩码：observation 与 user 段共 8671 字符被掩掉，assistant 目标段 3693 字符参与训练
[5] 与真实 Qwen3 chat template 交叉比对：已比对 20 条，逐字符一致
[6] 已生成 JSON 的角色校验：三个 split 全部合法
```

**未执行真实 LLaMA Factory 预处理的原因**：本机（macOS / Apple Silicon）没有安装
`llamafactory`、`torch`、`transformers`（`python3 -c "import torch"` 报 ModuleNotFoundError），
也没有 Qwen3-8B 的分词器；按要求不下载模型。因此改为**离线等价验证**：
按源码复现 converter 的角色规则与 `qwen3_nothink` 的槽位拼接，并用仓库内**已有的**
Qwen3 分词器模板（来自上一轮 Smoke 训练产物）做逐字符交叉比对。
真机 `llamafactory-cli train ... --do_train false` 的预处理留待 4090 环境执行。

---

## 5. 人工抽查（第二轮，53 条）

抽样规则：**全部 25 条 observation 样本** + 6 条高风险 + 9 个类别各 2 条 + 三个 split 各补 2 条，去重后 53 条。

| 覆盖维度 | 实际 |
|---|---|
| split | train 37 / validation 6 / test 10 |
| 类别 | 9 / 9 全覆盖 |
| observation 样本 | **20 / 20 全覆盖（抽查时为 25 条，后经引用核对收敛为 20 条：13 条订单 Tool + 6 条知识库命中 + 1 条知识库未命中降级）** |
| risk_level = high | 8 条 |

### 5.1 重点核查结论

| 核查项 | 抽查结论 |
|---|---|
| observation 转述是否越界 | 20 条全部只转述块内字段；`estimated_delivery=null` 时明确说"没有给出预计送达时间，我不替它估"；`<字段缺失>` 时明确说"不能凭空判断" |
| 知识库引用是否可追溯 | 命中类共 **6 条**，全部指向 `knowledge/repair/{refrigerator,television,monitor}.md` 的真实章节，**引用版本一律为 `1.0.0`**；其后的回复均点出文档名与版本（如 `refrigerator.md 紧急安全分流，版本 1.0.0`），并保留"以该型号说明书为准""由售后按适用标准判定"这类限定。另有 **1 条未命中降级**（`id-tr-x03`），明确说明相关度低于阈值并转人工，不给可能不准确的条款 |
| 维修事实是否有依据 | 无 observation 的维修类样本一律改为收集现象 + 声明需检索，例如"后壁结冰是否属于正常现象，要按该机型是直冷还是风冷来判断，我不能一概而论" |
| 政策事实是否有依据 | 退换货/保修类一律改为"按该订单适用的现行规则核对后给明确口径"。因 `knowledge/policies/` 尚未建立，**政策类样本全部不带 observation**：`fr-te-09`（碰撞致损）等只声明需检索适用条款并转由现场判定，不引用任何政策文档，也不给保修结论 |
| 危险维修建议 | 8 条高风险样本全部为"明确拒绝 + 说明风险 + 安全替代 + 断电/远离/联系专业售后"结构；`sr-tr-a03`（用户要泼水灭火）正确阻止并给出断电顺序与消防路径 |
| 订单状态 | 无 observation 的订单样本只表达"我用 ORDxxxx 去查"，状态词一律出现在"未出库…已出库…"条件句里 |
| 提示注入 | `id-te-03`（要求忽略规则强制退款）拒绝越权的同时仍正常受理退款诉求，并在 `http_503` 下明确"不会告诉您已经受理了" |

### 5.2 本轮抽查发现并修复的问题

| 样本 | 问题 | 修复 |
|---|---|---|
| `wa-tr-n13`、`wa-tr-t04` | "这种情况**多为**支付渠道回调延迟"——对业务系统的归因断言，与维修归因同性质，第一版正则未覆盖 | 改为"已扣款但订单未更新的原因我不先归结到某一项 / 需要看流水才能确定，我不先猜" |

### 5.3 审计驱动发现并修复的问题（本轮）

| 来源 | 问题 | 修复 |
|---|---|---|
| 事实断言扫描 | 130 条样本含无依据的故障归因、操作路径、维修量值或政策结论 | 逐条改写；其中 12 条改为带知识库 observation 的有依据回答 |
| 检查 26 误判 | `请简单说明 / 一句话说明 / 或者说明 / 并分别说明` 被当成因果推断断言（5 处） | 把 `说明` 模式改为正向后视：只在前接症状词或位于分句开头时判定 |
| 检查 26 误判 | `菜单里这几项的位置按机型不同，我按型号核对` 被当成操作路径断言（2 处） | 收紧为"给出可执行路径"才判定：`路径在/是`、`菜单里…打开/关闭/调到`、`长按…键…秒` |
| 检查 26 漏判 | `通常不收费` 未被政策模式覆盖（1 处） | 正则扩为 `通常不(?:额外)?收(?:费\|取)` |
| 检查 24 误判 | `未出库…，已出库…` 条件句被按分句切断，后半句被判为状态断言（8 处） | 条件标记改为**整句**判定 |
| 检查 16 失效 | 依据块迁到 observation 后，仍按 `user` 轮统计，导致"0 条带依据块" | 改按 observation 角色统计，并拆分为工具块 13 / 检索块 12 |
| 检查 2 冲突 | 原逻辑要求 user/assistant 严格交替，observation 会被判角色顺序错误 | 改为 user 侧允许 `user` 或 `observation`，与 LF 的 `odd_tags` 一致 |
| 审计脚本 | `RESULT_MARKS` 未导入导致 NameError | 补齐导入 |

### 5.4 第一轮已修复问题（保留记录）

| 审计项 | 问题 | 修复 |
|---|---|---|
| 5 | 两条样本首轮用户问题都是"我要开发票。" | 改为"发票要怎么申请？" |
| 9 | 冒烟数据的 `YD202605300001` 未被 legacy 正则匹配（写成 `YD\d{14}`，实际 12 位数字） | 放宽为 `YD\d{12,14}`，仅对冒烟文件生效 |
| 10 | 两处危险关键词与指导语同句 | 改写为"让内部润滑油回流到位""可以先做一个免拆的判断" |
| 18 | 订单、投诉、安全三类缺 RAG 样本，安全类还缺 Tool 样本 | 调整 6 条样本内容与元数据 |
| 人工复查 | `rr-tr-x08` 从 `refund_stage=待财务打款` 推断出"已通过审核"，超出工具返回 | 改为只转述"处理中 / 停在待财务打款环节" |
| 人工复查 | `wa-va-08` 内容需 RAG+Tool 但元数据为 false | 改为 `rt` |
| 人工复查 | `sr-te-03` 混用半角分号 | 改为句号，并全量扫描确认无半角标点 |

---

## 6. 本轮改动量

| 项目 | 数量 |
|---|---:|
| 基线（`e435c38`）样本数 | 800 |
| 当前样本数 | 800（uid 集合完全一致，**无新增、无删除**） |
| assistant 文本被改写的样本 | **315** |
| 其中：冰箱 / 彩电 / 显示器 | 102 / 88 / 97 |
| 其中：退换货 / 保修 / 订单 / 安全 / 注入 | 14 / 7 / 2 / 3 / 2 |
| 仅调整 `requires_rag` / `requires_tool` 元数据的样本 | 4 |
| 工具结果轮：由伪装 user → observation | 14 轮（13 条样本） |
| 新增知识库 observation 依据的样本 | 7 |
| 删除的样本 | **0** |

> 315 条中相当一部分是"顺带收紧"：例如冰箱模块 46 条被扫描命中，但为保持同一模块内
> 表达一致，相邻的同类回答也一并从"直接给结论"改成"声明需检索"，因此实际改写数高于命中数。
> 每条样本的 uid、split、category、scenario 与用户问题原文均未改动。

---

## 7. 正式训练配置要点

文件：`configs/train-qwen3-8b-qlora-production-linux.yaml`（**草案，尚未执行训练**）

| 项 | 取值 |
|---|---|
| `model_name_or_path` | `/workspace/models/Qwen3-8B` |
| `model_revision` | `b968826d9c46dd6066d109eabc6255188de91218`（开训前用 `git rev-parse HEAD` 核验，不一致不得开训） |
| 量化 | `quantization_bit: 4`、`quantization_method: bnb`、`quantization_type: nf4`、`double_quantization: true` |
| 精度 | `bf16: true`、`compute_dtype: bfloat16` |
| 方法 | `stage: sft`、`finetuning_type: lora`（QLoRA） |
| LoRA | `lora_rank: 16`、`lora_alpha: 32`、`lora_dropout: 0.05`、`lora_target: all` |
| 模板 | `qwen3_nothink`（已核实该版本存在且带 `format_observation`） |
| `cutoff_len` | `1536` |
| 训练集 | `customer_service_train_640` |
| 验证集 | `eval_dataset: customer_service_validation_80` |
| 测试集 | **未出现在 `dataset` / `eval_dataset` 字段中**，仅在注释里记录 SHA-256 与禁用声明 |
| 学习率 | `1.0e-4`，`cosine`，`warmup_ratio: 0.1` |
| epoch | `3.0`（640 / (1×8) = 80 步每 epoch，共约 240 步） |
| 最佳 checkpoint | `eval_strategy/save_strategy: steps`、`eval_steps/save_steps: 20`、`load_best_model_at_end: true`、`metric_for_best_model: eval_loss`、`greater_is_better: false`、`save_total_limit: 3` |
| `report_to` | `none` |
| 输出目录 | `…/qwen3-8b/customer-service-production-v1`（与 Smoke 分离，`overwrite_output_dir: false`） |

`metric_for_best_model` 取 `eval_loss`，其来源只有 validation 集；test 集不参与训练、
不参与验证、不参与 checkpoint 选择。

---

## 8. 建议的下一步

1. **4090 环境上先跑一次真机预处理**：`llamafactory-cli train <config> --do_train false --max_samples 8`，
   确认 observation 轮被编码为 `<tool_response>` 且 label 掩码正确，再开正式训练。
2. **补齐 RAG 侧文档**：`knowledge/repair/` 下三份维修指南已就绪（版本 1.0.0），
   6 条 observation 已对齐到其真实章节。仍缺 `knowledge/policies/`
   （客服 SOP、退款规则、物流规则、保修免责、像素判定标准）——正是因为缺这部分，
   本轮把 5 条政策类 observation 改回了"需检索"形态。policies 文档补齐后，
   可以把这 5 条重新升级为带引用的 grounded 样本，届时审计第 27 项会自动校验引用有效性。
3. **接线 Agent 评测**：`datasets/agent-tool-evaluation.json` 的 12 个用例需要 runner，
   并在 Mock 后端注入 `timeout` / `http_500` / `field_missing` 三种故障态
   （当前 `services/mock_backend.py` 只实现正常与 404）。属服务侧改造，本次未触碰。
4. **考虑补 `function_call` 轮**：待真机可验证 `FunctionFormatter` 的 JSON 约定后，
   把 assistant 发起查询改为标准 `<tool_call>`，与 Mastra 推理态进一步对齐。
5. **固定评测口径**：为 test-80 配打分脚本，按 SOP 合规率、澄清追问率、无依据拒答率、
   高风险拦截率四项出 Base vs QLoRA 对比报告。
