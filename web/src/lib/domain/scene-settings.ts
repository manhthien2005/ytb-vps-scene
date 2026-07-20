import { z } from "zod";

const rectangle = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((value, context) => {
  if (value.x + value.width > 1) context.addIssue({ code: "custom", message: "rectangle exceeds width" });
  if (value.y + value.height > 1) context.addIssue({ code: "custom", message: "rectangle exceeds height" });
});

const schema = z.object({
  sourceSubtitle: rectangle,
  logo: rectangle,
  voice: z.enum(["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"]),
  rate: z.number().min(0.8).max(1.2),
}).strict();

export type SceneRectangle = Readonly<z.infer<typeof rectangle>>;
export type SceneSettings = Readonly<z.infer<typeof schema>>;

export function parseSceneSettings(value: unknown): SceneSettings {
  return schema.parse(value);
}
