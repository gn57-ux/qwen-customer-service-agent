# 4090 正式训练执行手册

面向 **Ubuntu 22.04 + RTX 4090 24GB + LLaMA Factory 0.9.5** 的分阶段执行包。
八个阶段各自独立，**不提供全自动串跑**：每阶段成功后写一个 `.ok` 状态文件，
下一阶段启动时校验前置状态，缺失即拒绝执行。

**两个目录，职责严格分离**（本轮 Review 修正）：

```text
# Trainer 目录：只给 LLaMA Factory。正式开训前必须不存在或为空。
/workspace/training-artifacts/qwen3-8b/customer-service-production-v1/
├── checkpoint-*/          训练 checkpoint（脚本永不删除）
├── trainer_state.json     eval_loss 历史与 best_model_checkpoint
├── tokenizer 资产 / training_loss.png

# Control 目录：流程侧的一切产物。
/workspace/training-artifacts/qwen3-8b/customer-service-production-v1-control/
├── logs/                  各阶段完整 stdout/stderr
├── stage-state/           阶段完成标记、最佳 checkpoint 路径
├── preflight/             准入报告 + model-revision.json（revision 证据）
├── preprocess/            预处理报告 + tokenized-verify.json
├── tokenized-preprocess/  llamafactory-cli 落盘的 tokenized 数据
├── run-meta/              训练运行记录（时间、commit、SHA、revision）
├── selection/             checkpoint 选择报告
├── adapter-reload/        Adapter 重载校验报告
├── evaluation/            Base / QLoRA 评测 JSONL + 汇总 + 对比
└── package/               Adapter 归档 tar.gz + SHA-256 + 清单
```

阶段 01–03 **不创建也不写入 Trainer 目录**；阶段 04 开训前会检查它不存在或为空，
非空时列出已有 checkpoint 并给出三种人工方案（换目录 / 归档后重训 / 显式续训），
**绝不自动续训、删除或覆盖**，`overwrite_output_dir` 保持 `false`。

需要换路径时用环境变量（两者建议成对设置）：

```bash
TRAINER_OUTPUT_DIR_OVERRIDE=<新 trainer 路径> \
TRAINING_CONTROL_DIR=<新 control 路径> \
bash training/run.sh train
```

## 0. 前置事实（已冻结，勿改）

| 项 | 值 |
|---|---|
| 数据冻结提交 | `afa83d0` |
| train-640 | `76464f6b2da0be60d30e796d566e80f7c5fb3597d61020c5c36d49a841e4d5e7` |
| validation-80 | `d8cbcf9a0cbf303f1340b36594f66308ebaf4487650a605c509267bb8226c2e8` |
| test-80 | `7baa23aec2e35c4744d2f2cf8bccf3b65b773f678d3244caf867551b8a8a8406` |
| 基础模型 | `Qwen/Qwen3-8B` |
| revision | `b968826d9c46dd6066d109eabc6255188de91218` |
| 训练配置 | `configs/train-qwen3-8b-qlora-production-linux.yaml`（唯一参数来源） |

**test-80 只在阶段 03 与 07 被读取**，不参与训练、调参、checkpoint 选择、
early stopping。阶段 05 的选择脚本根本不打开该文件。

## 1. 在哪台机器跑什么

| 阶段 | Mac | 4090 | 说明 |
|---|:--:|:--:|---|
| 1 preflight | 部分 | **必须** | Mac 上 GPU/CUDA/LLaMA Factory 项标记为"4090 真机待验证"，数据/配置项照常严格 |
| 2 preprocess | 部分 | **必须** | Mac 上 token 统计与 LF 读取无法完成，阶段不会标记完成 |
| 3 base-eval | 否 | **必须** | 需要加载 8B 模型 |
| 4 train | 否 | **必须** | 脚本显式拒绝在非 Linux 上运行 |
| 5 select-best | 可 | **必须** | 只读 `trainer_state.json`，Mac 上拿到产物后也能复算 |
| 6 adapter-reload | 否 | **必须** | 需要 CUDA |
| 7 adapter-test | 否 | **必须** | 需要 CUDA |
| 8 package | 可 | **必须** | 需要 checkpoint 在本地 |

Mac 侧只做：数据/配置静态校验、脚本语法与编译检查、评测链路自检（`--dry-run`）、
产物下载后的复核。**不承担训练与推理。**

## 2. 八阶段命令

准备（4090，一次性）：

```bash
cd /workspace
git clone <repo> qwen-customer-service-agent
cd qwen-customer-service-agent
git checkout afa83d0
```

> 仓库必须位于 `/workspace/qwen-customer-service-agent`，因为训练配置里的
> `dataset_dir` 是绝对路径。路径不符时阶段 01 会直接失败，**脚本不会擅自改配置**。

基础模型需要人工准备到 `/workspace/models/Qwen3-8B`，并核对
`git rev-parse HEAD` 等于上表 revision。**执行包不会自动下载模型**：
目录不存在时阶段 01 报错退出，由你决定来源与许可证。

```bash
# 1. 准入
bash training/run.sh preflight

# 2. 真机预处理门禁（只处理 train-640 + validation-80）
bash training/run.sh preprocess

# 3. Base 基线（test-80）
bash training/run.sh base-eval

# 4. 正式 QLoRA 训练
bash training/run.sh train

# 5. 最佳 checkpoint（依据 validation eval_loss）
bash training/run.sh select-best

# 6. Adapter 重载校验
bash training/run.sh adapter-reload

# 7. 独立终测 + Base vs QLoRA 对比
bash training/run.sh adapter-test

# 8. 打包与解压回验
bash training/run.sh package
```

随时查看进度：

```bash
bash training/run.sh status
```

## 3. 每阶段门禁

| 阶段 | 通过条件（任一不满足即非零退出） |
|---|---|
| 01 preflight | git 可读；GPU 显存 ≥ 20GB；PyTorch+CUDA 可用；`llamafactory-cli` 存在；基础模型目录存在且 **revision 由可信证据证明**（见 §9）；Trainer 目录不存在或为空；三份数据条数 640/80/80 且 SHA-256 与 manifest **和训练配置注释**三处一致；`dataset_info.json` 注册完整含 `observation_tag`/`function_tag`；test 未出现在 `dataset`/`eval_dataset`；审计脚本退出码 0；`dataset_dir` 与仓库路径一致；输出目录与 Smoke 目录不重叠；可用磁盘 ≥ 60GB |
| 02 preprocess | `template=qwen3_nothink`；640/80 条全部转换；observation 全部渲染进 `<tool_response>`；observation/user 段归入 source（label=IGNORE_INDEX）；角色序列合法且 user/assistant 轮无工具标记；token 长度分布与 cutoff_len=1536 截断率产出；`llamafactory-cli` **真实落盘 tokenized 产物**并通过张量级校验（条数 640/80、无 test split、input_ids/labels 等长、assistant 区有非 IGNORE label、system/user/observation 区全为 IGNORE、17 轮 observation 全部被 mask）；与真实 `chat_template.jinja` 交叉比对一致。**任一项处于"4090 真机待验证"即拒绝进入训练** |
| 03 base-eval | test 条数恰好 80、成功生成恰好 80；任一条异常即非零退出（JSONL 与 summary 仍保留）；禁止 `--limit`；报告写入 Control 的 `evaluation/`；不覆盖既有结果 |
| 04 train | 重跑 01/02 的数据与配置门禁；`overwrite_output_dir=false`；Trainer 目录 ≠ Smoke 目录；**Trainer 目录不存在或为空**（非空即拒，不自动续训）；训练退出码 0 且产出 `trainer_state.json` |
| 05 select-best | `trainer_state.json` 存在；`best_model_checkpoint` 与 `best_metric` 齐全；`best_metric` 等于 `log_history` 中最小 `eval_loss` 且与该 checkpoint 的记录一致；最佳目录含 `adapter_config.json` + `adapter_model.safetensors`；分词器文件可在 checkpoint 或 output_dir 找到；配置 `metric_for_best_model=eval_loss` 且 `greater_is_better=false` |
| 06 adapter-reload | Adapter 目录存在；`peft_type == LORA`；CUDA 可用；Base+Adapter 加载成功；2 条最小 prompt 均产出非空文本 |
| 07 adapter-test | 同 03 的完整性门禁；对比前双侧均须 **非 dry-run、非 debug、count=80、generated=80**，且**生成配置指纹与 test SHA-256 完全一致**（否则判不可比，直接失败） |
| 08 package | 必需文件齐全；白名单未混入训练状态文件；归档与暂存目录均不覆盖既有文件；解压后逐文件 SHA-256 一致且 `adapter_config.json` 可解析、`peft_type=LORA` |

## 4. Base / QLoRA 评测口径

同一份代码 `training/tools/evaluate.py`、同一份 test-80、同一组生成参数
（在该文件里**只定义一次**，Base 与 Adapter 都无法覆盖）：

```text
do_sample=False   num_beams=1   max_new_tokens=512
repetition_penalty=1.0   seed=20260729   enable_thinking=False
4-bit NF4 + double quant + bfloat16 compute
```

报告里记录这组参数的 SHA-256 指纹；阶段 07 会硬比对两侧指纹，不一致就拒绝出对比报告。

逐条记录 uid、category、scenario、risk_level、输入消息、参考答案、模型回答、耗时，
写入 `eval-*.jsonl`；汇总写入 `.summary.json` 与 `.summary.md`。

**规则指标（自动、可复核）** —— 词表与正则直接 import 自
`scripts/audit_customer_service_dataset.py`，与数据审计同一套口径，每条判定都附
触发它的原文片段：

- 生成完整率 / 空回答率 / 澄清追问率 / 无依据拒答率
- 边界合规率（不编造订单事实、不做无依据断言、不伪造 observation 块）
- 危险维修建议命中数（句级：危险词 + 可执行动作提示 且无禁止性表述）
- 动态订单事实编造命中数（无 Tool observation 依据却断言状态/日期/节点）
- 高风险拦截率（`risk_level=high` 子集）
- 提示注入拒绝率（`category=injection_degradation` 子集）
- 按 category / scenario / risk_level 分组

**人工复核项（不自动打分，报告里以待办清单输出）**：有用性、澄清是否问到点上、
语气贴合度、对 observation 的转述忠实度、是否过度拒答、多轮连贯性。

> 规则命中率**不是**模型质量分。它只回答"有没有越界"，不回答"答得好不好"。
> 两者在报告中分开呈现，不做加权合成。

## 5. 失败后从哪里恢复

| 失败点 | 处理 |
|---|---|
| 01 数据 SHA 不符 | 数据被改动过。重跑 `build` + `audit`，更新 manifest/报告/训练配置后重新提交，再回到 01 |
| 01 模型缺失或 revision 不符 | 人工准备正确 revision 的权重。**不要**让脚本下载 |
| 02 tokenized 校验失败 | 看 `preprocess/tokenized-verify.json` 的 problems 列表：条数、labels 掩码或 observation 定位问题都会逐条列出；修 source module → 重建数据 → 重跑 01 |
| 02 LF 不支持该调用 | 若 `--do_train false` + `--tokenized_path` 未产出 tokenized 目录，脚本会停下并报错。**不要凭日志文字放行**：先在 4090 实测可行的替代调用方式，确认后再继续 |
| 02 截断率偏高 | 由人决定是否调 `cutoff_len`；改配置会改变配置 SHA，需同步登记 |
| 04 训练中断 | **现场保留**，checkpoint 未删。看 `run-meta/*.json` 与日志；换 `TRAINER_OUTPUT_DIR_OVERRIDE` + `TRAINING_CONTROL_DIR` 重跑，或人工归档后重来；阶段 04 会因目录非空而拒绝，不会自动续训 |
| 04 OOM | 降 `per_device_train_batch_size` 或升 `gradient_accumulation_steps`（改配置即改 SHA，需登记）；不要动数据 |
| 05 状态矛盾 | 不要猜。人工看 `trainer_state.json` 与 `logs/`，确认是否训练被中断在保存中途 |
| 06 重载失败 | 检查 Base revision 与 checkpoint 是否同源；`adapter_config.json` 的 `base_model_name_or_path` 应指向同一 Base |
| 07 指纹不一致 | 说明两次评测参数不同，结果不可比。重跑 Base 或 Adapter 评测，不要手工改报告 |
| 08 解压回验失败 | 归档损坏。原 checkpoint 完好，重跑打包即可（新时间戳，不覆盖旧包） |

阶段状态文件在 Control 目录的 `stage-state/`。要重跑某阶段，删掉它自己的 `.ok` 即可 ——
**不要删除 Trainer 目录里的 checkpoint**。

## 6. 什么时候可以关闭租赁机

**本次必做关机条件**（全部满足即可关机）：

1. 最佳 Adapter 重载 PASS（阶段 06）
2. test-80 终测完成（阶段 07，Base 与 QLoRA 均 count=80 / generated=80）
3. Adapter 打包与解压复核 PASS（阶段 08）
4. `tar.gz`、`manifest.json`、评测报告、日志已下载到 Mac
5. 在 Mac 上 `shasum -a 256` 与 manifest 的 `archive_sha256` 核对一致
6. 至少两份备份（Mac 本地 + 外置盘/对象存储）

**融合 / GGUF / MLX 导出**：

- 当前**未批准**，不属于本次课程必做项；
- 只有后续明确需要某种特定部署格式时才单独实施；
- **不阻塞本次关闭租赁机**。

## 7. 把产物下载回 Mac

```bash
scp -r <user>@<4090>:/workspace/training-artifacts/qwen3-8b/customer-service-production-v1/package    ~/Documents/ai客服-artifacts/
scp -r <user>@<4090>:/workspace/training-artifacts/qwen3-8b/customer-service-production-v1/evaluation ~/Documents/ai客服-artifacts/
scp -r <user>@<4090>:/workspace/training-artifacts/qwen3-8b/customer-service-production-v1/selection  ~/Documents/ai客服-artifacts/
scp -r <user>@<4090>:/workspace/training-artifacts/qwen3-8b/customer-service-production-v1/logs       ~/Documents/ai客服-artifacts/
scp -r <user>@<4090>:/workspace/training-artifacts/qwen3-8b/customer-service-production-v1/run-meta   ~/Documents/ai客服-artifacts/
```

Mac 上复核：

```bash
shasum -a 256 ~/Documents/ai客服-artifacts/package/customer-service-production-v1-*.tar.gz
```

与 `*.manifest.json` 的 `archive_sha256` 比对一致后，再考虑释放 4090。

## 8. Mac 本机可跑的检查

```bash
bash -n training/run.sh training/lib/common.sh training/stages/*.sh
python3 -m py_compile training/tools/*.py
python3 training/tools/evaluate.py --dry-run --output-dir /tmp/eval-selftest
python3 training/tools/preprocess_report.py --output-dir /tmp/pre-selftest
python3 scripts/audit_customer_service_dataset.py
python3 scripts/verify_template_encoding.py --jinja
```

`--dry-run` 用 test-80 的参考答案冒充模型输出，**只验证规则指标链路**，
产出的报告顶部会显式声明这一点，不能当成任何模型的评测结果。

## 9. 基础模型 revision 的可信证据

阶段 01 在 Linux 上把 revision 当**硬门禁**：证明不了就 FAIL，
不接受"人工确认后继续"。证据按优先级采信，多个证据并存时必须互相一致：

| 优先级 | 证据源 | 说明 |
|---|---|---|
| 1 | `git` | 模型目录是 git 仓库，读 HEAD。**工作区脏则判 FAIL** —— commit 不能代表磁盘内容 |
| 2 | `hf-local` | `huggingface-cli download --local-dir` 留下的 `.cache/huggingface/download/*.metadata`，首行是 commit hash。出现多个不同 commit 即拒绝 |
| 3 | `hf-snapshot` | 目录位于（或软链到）HF 缓存 `snapshots/<commit>/`，并与 `refs/*` 交叉核对 |
| 4 | `manifest` | `<model_dir>/revision-manifest.json`。**只写 revision 字符串不算证据**：必须绑定文件清单与 SHA-256，且至少覆盖 `config.json`、`tokenizer_config.json`、`tokenizer.json` 与一个权重文件；工具会逐个重算哈希比对 |

采信结果写入 `<control>/preflight/model-revision.json`，含用了哪一种证据。

当前 `/workspace/models/Qwen3-8B` 若没有可验证元数据，先跑只读排查：

```bash
python3 training/tools/verify_model_revision.py --model-dir /workspace/models/Qwen3-8B --inspect
python3 training/tools/verify_model_revision.py --manifest-schema
```

这两条命令只打印，不修改任何文件、不联网、不下载。**如何补 manifest 由你在训练机现场决定**。

## 10. 真机 labels 掩码怎么验

阶段 02 不再靠"日志里出现 Loading dataset"判 PASS。流程是：

1. `llamafactory-cli train <yaml> --do_train false --do_eval false --tokenized_path <control>/tokenized-preprocess`
2. **产物不存在就直接 FAIL** —— 若本机 LF 版本不支持该调用，到这里必然停下，
   由你实测可行方式后再继续，不会凭日志文字放行；
3. `training/tools/verify_tokenized.py` 用 `datasets.load_from_disk` 读回真实张量，核验：
   - train 恰好 640、validation 恰好 80、**不存在 test split**
   - 每条都有 `input_ids` 与 `labels` 且长度一致
   - assistant 目标区存在非 `-100` 的 label（否则该条不产生梯度）
   - system / user / observation 区域全为 `-100`
   - 把 observation 正文用同一个 tokenizer 编码后在 `input_ids` 里定位，
     该区间的 labels 必须全是 `-100`；**定位不到即 FAIL**，不允许跳过
   - 每个 split 的 count / min / P50 / P95 / max / 超 1536 数 / 截断率
4. 结果写入 `<control>/preprocess/tokenized-verify.json`，预处理报告**只采信它**。

train+validation 共 **17 轮** observation 需要核验（全量 20 轮中另有 3 轮在 test，
test 不进入预处理）。期望值由冻结数据现算，不写死。

## 11. Mac 自动测试

```bash
bash training/tests/run-tests.sh
```

覆盖：Trainer/Control 目录隔离与"01–03 后 Trainer 目录仍为空"、revision 证据
（匹配/错配/无证据/假 manifest/篡改文件）、tokenized 结构与 labels 掩码、
evaluate 完整性（部分失败非零、`--limit` 保护、dry-run 隔离）、
checkpoint 选择与打包回归。全程不需要 CUDA、LLaMA Factory 或模型权重。
