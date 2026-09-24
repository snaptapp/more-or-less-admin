export const DUPLICATE_QUALITY_FLAGS = ["duplicate_question", "conflicting_answer"] as const;
export type DuplicateQualityFlag = (typeof DUPLICATE_QUALITY_FLAGS)[number];

export const DUPLICATE_FLAG_SET: ReadonlySet<string> = new Set<string>(DUPLICATE_QUALITY_FLAGS);

export const isDuplicateFlag = (flag: string): boolean => DUPLICATE_FLAG_SET.has(flag);
export const isNonDuplicateFlag = (flag: string): boolean => !DUPLICATE_FLAG_SET.has(flag);
