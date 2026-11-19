import { z } from "zod";

/** One question an escalation asks; `suggestedOptions` are answers a UI can offer as choices. */
export const escalationQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  context: z.string().min(1).optional(),
  suggestedOptions: z.array(z.string().min(1)).optional(),
});

/** What a task agent (or the fixer) writes to its inbox path to escalate. */
export const escalationFileSchema = z
  .object({
    reason: z.string().min(1),
    evidence: z.string().min(1),
    questions: z.array(escalationQuestionSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.questions.forEach((q, i) => {
      if (seen.has(q.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate question id ${q.id}`, path: ["questions", i, "id"] });
      }
      seen.add(q.id);
    });
  });
export type EscalationFile = z.infer<typeof escalationFileSchema>;

/** What the engine stores at `<runDir>/escalations/E<n>.json`. */
export const escalationRecordSchema = escalationFileSchema.safeExtend({
  id: z.string().regex(/^E\d+$/),
  source: z.enum(["agent", "validation"]),
  /** The task id, or `fixer`. */
  node: z.string(),
  attempt: z.number().int().min(0),
  createdAt: z.string(),
  status: z.enum(["open", "resolved"]),
  /** The task branch holding the escalated attempt's commits, when there is one. */
  branch: z.string().optional(),
  /** The review round of a fixer escalation (node `fixer`). */
  round: z.number().int().min(0).optional(),
  resolvedAt: z.string().optional(),
  resolution: z.unknown().optional(),
});
export type EscalationRecord = z.infer<typeof escalationRecordSchema>;
