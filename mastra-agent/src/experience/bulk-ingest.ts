/**
 * `experience:ingest [--rebuild]` 的核心逻辑——扫描 `knowledgeRoot` 下
 * 全部经验 Markdown，逐个校验+摄取。`--rebuild` 时先清空 Collection
 * 再全量重建（对应 `experience:rebuild` 别名，二者共享本函数）。
 *
 * **增量路径（非 `--rebuild`）的孤儿点清理**（Codex Review 指出的真实
 * bug）：文档被删除、编辑成不合法内容后，旧版本原来只是被跳过，Qdrant
 * 里对应的向量点原样保留——如果旧版本是 `verified`，检索会继续命中
 * 一份已经不存在/已失效的经验。修复：结构校验通过的文档（不管本次
 * `ingestExperience()` 是否真的成功——摄取失败大多是瞬时故障，不能因为
 * 一次瞬时失败就把上次成功摄取、内容依然合法的旧向量当孤儿清理掉）计入
 * `validDocumentIds`；扫描完成后用 `store.listPoints()` 取出**这个
 * knowledge_set 范围内**全部现存点，document_id 不在 `validDocumentIds`
 * 里的即为孤儿，批量 `deletePoints()`。`listPoints()`/`deletePoints()`
 * 都是 `ExperienceStore` 自己的方法，天然绑定在 `cfg.collection`/
 * `cfg.knowledgeSet` 上，不会触达客服知识库的 Collection。
 * `deprecated` 状态的合法文档不受影响——它照常通过校验、正常走
 * `ingestExperience()` 的 upsert 路径覆盖旧 payload，不属于孤儿。
 *
 * **`--rebuild` 的删除失败必须中止**（同一轮 Codex Review 指出的另一个
 * 真实 bug）：`store.deleteIndex()` 底层（`@mastra/qdrant`）已经正确区分
 * "collection 不存在"（视为已删除，直接返回）和真实删除失败（抛出
 * `MastraError`）——之前这里用 `.catch(() => {})` 把两种情况一并吞掉，
 * 真实删除失败时会静默继续对着未清空的旧 Collection 摄取，之后却报告
 * "已完成 rebuild"。修复：不再包一层 catch，直接让真实失败原样抛出，
 * 中止整个摄取（不返回 report，调用方——CLI 的 `main().catch()`——会
 * 打印错误并以非零退出码收尾，不会假装同步成功）。
 */

import type { EmbeddingClient } from "../rag/embedding.ts";
import { ingestExperience, type ParsedExperienceDocument } from "./ingest-pipeline.ts";
import { validateExperience } from "./schema.ts";
import { scanExperienceFiles } from "./scan.ts";
import type { ExperienceStore } from "./store.ts";

export interface BulkIngestFailure {
  relativePath: string;
  error: string;
}

export interface BulkIngestReport {
  documentCount: number;
  successCount: number;
  failures: BulkIngestFailure[];
  /** 增量路径清理掉的孤儿向量点数（--rebuild 路径恒为 0，见函数说明） */
  orphansRemoved: number;
}

export async function runBulkIngest(
  experienceRoot: string,
  embedder: EmbeddingClient,
  store: ExperienceStore,
  opts: { rebuild?: boolean } = {},
): Promise<BulkIngestReport> {
  if (opts.rebuild) {
    // 不吞错误：真实删除失败必须让调用方感知，不能装作 rebuild 成功。
    await store.deleteIndex();
  }
  const description = await store.describe();
  if (!description.exists) {
    await store.createIndex(embedder.dimension, "cosine");
  }

  const files = await scanExperienceFiles(experienceRoot);
  const failures: BulkIngestFailure[] = [];
  let successCount = 0;
  const validDocumentIds = new Set<string>();

  for (const file of files) {
    if (!file.frontmatter) {
      failures.push({ relativePath: file.relativePath, error: file.parseError ?? "frontmatter 解析失败" });
      continue;
    }
    const validation = validateExperience(file.frontmatter, file.body);
    if (!validation.ok) {
      failures.push({ relativePath: file.relativePath, error: validation.errors.join("; ") });
      continue;
    }
    validDocumentIds.add(file.frontmatter.document_id);
    const doc: ParsedExperienceDocument = {
      documentId: file.frontmatter.document_id,
      documentVersion: file.frontmatter.document_version,
      title: file.frontmatter.title,
      stage: file.frontmatter.stage,
      taskType: file.frontmatter.task_type,
      projectScope: file.frontmatter.project_scope,
      riskLevel: file.frontmatter.risk_level,
      status: file.frontmatter.status,
      occurrenceCount: file.frontmatter.occurrence_count,
      sourceFile: file.relativePath,
      body: file.body,
    };
    try {
      await ingestExperience(embedder, store, doc);
      successCount += 1;
    } catch (e) {
      failures.push({ relativePath: file.relativePath, error: (e as Error).message });
    }
  }

  let orphansRemoved = 0;
  if (!opts.rebuild) {
    // listPoints()/deletePoints() 均未捕获——Qdrant 不可达等故障会直接
    // 抛出，中止整个函数，不返回 report，不允许在"孤儿点核实/清理失败"
    // 的情况下仍然报告摄取已同步。
    const existingPoints = await store.listPoints({ knowledgeSet: store.knowledgeSet });
    const orphanIds = existingPoints.filter((p) => !validDocumentIds.has(p.documentId)).map((p) => p.id);
    if (orphanIds.length > 0) {
      await store.deletePoints(orphanIds);
      orphansRemoved = orphanIds.length;
    }
  }

  return { documentCount: files.length, successCount, failures, orphansRemoved };
}
