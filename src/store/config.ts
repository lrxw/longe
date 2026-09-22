import * as YAML from "yaml";
import { z } from "zod";
import { ParseError } from "../domain/errors.js";
import { formatZodIssues } from "../domain/schemas.js";

export const configSchema = z.looseObject({
  version: z.literal(1),
  project: z.string().trim().min(1).optional(),
});
export type Config = z.infer<typeof configSchema>;

export function parseConfig(text: string, file?: string): Config {
  const parsed = configSchema.safeParse(YAML.parse(text) ?? {});
  if (!parsed.success) throw new ParseError(formatZodIssues(parsed.error), file);
  return parsed.data;
}
