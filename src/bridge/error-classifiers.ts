export function isStaleSessionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /no conversation found|conversation not found|session id|invalid session|thread\/resume.*failed|no rollout found|multiple.*tool_result.*blocks|each tool_use must have a single result/i.test(errorMessage);
}

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /context.window.exceeds.limit|context.length.exceeded|context.too.long|max.context.length|token.limit.exceeded|maximum.context/i.test(errorMessage);
}
