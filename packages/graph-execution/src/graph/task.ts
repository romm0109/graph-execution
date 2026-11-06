import { z } from "zod";

/** Shape of a task file `tasks/<id>.json` (PRD §7.1). Ids are opaque strings. */
export const taskSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  /** Command list override, `false` to skip validation, `null`/absent to use `config.validate`. */
  validate: z.union([z.array(z.string()), z.literal(false), z.null()]).optional(),
});

export type Task = z.infer<typeof taskSchema>;
