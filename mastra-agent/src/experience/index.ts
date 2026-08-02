export {
  type ExperienceFrontmatter,
  type RequiredSection,
  type ValidationResult,
  type DocumentIdInput,
  REQUIRED_SECTIONS,
  generateDocumentId,
  parseExperienceSections,
  validateExperience,
  parseExperienceFile,
  coerceFrontmatter,
  serializeExperienceFile,
} from "./schema.ts";
export { redact, type RedactResult } from "./redact.ts";
export {
  upsertExperience,
  type UpsertCandidate,
  type UpsertResult,
  acquireLock,
  lockPathFor,
  atomicWriteExperience,
  LockLostError,
  type LockHandle,
} from "./write.ts"; // acquireLock/lockPathFor/LockLostError 供 Feature 3 finalize 复用同一把锁
export {
  transition,
  transitionIdempotent,
  canVerify,
  type Status,
  type VerifyEvidence,
} from "./lifecycle.ts";
