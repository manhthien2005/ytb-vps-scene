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

const legacyEdgeVoices = new Set(["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"]);
const fixedVoice = z.preprocess(
  (value) => typeof value === "string" && legacyEdgeVoices.has(value) ? "BV074_streaming" : value,
  z.literal("BV074_streaming"),
);

const rate = z.number().min(0.8).max(1.2);

const legacySchema = z.object({
  version: z.literal(1).default(1),
  sourceArtifactId: z.string().uuid().nullable().default(null),
  sourceSubtitle: rectangle,
  logo: rectangle,
  voice: fixedVoice,
  rate,
}).strict();

const renderSplitSettings = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("single"),
  }).strict(),
  z.object({
    mode: z.literal("fixedSeconds"),
    secondsPerPart: z.number().int().min(1).max(86_400),
  }).strict(),
]);

const blurRegionSettings = z.object({
  kind: z.enum(["sourceSubtitle", "logo", "custom"]),
  enabled: z.boolean(),
  rectangle,
}).strict();

const blurSettings = z.object({
  mode: z.enum(["manual", "auto"]),
  // These manual regions are also the deterministic fallback for auto mode.
  regions: z.array(blurRegionSettings).min(2).max(8),
}).strict().superRefine((value, context) => {
  for (const kind of ["sourceSubtitle", "logo"] as const) {
    const count = value.regions.filter((region) => region.kind === kind).length;
    if (count !== 1) {
      context.addIssue({
        code: "custom",
        path: ["regions"],
        message: `expected exactly one ${kind} fallback region`,
      });
    }
  }
});

const outputSettings = z.object({
  format: z.literal("mp4"),
}).strict();

const presetMetadata = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string()
    .min(1)
    .max(100)
    .refine((value) => value.trim().length > 0, "preset name must contain visible text")
    .nullable()
    .default(null),
}).strict().superRefine((value, context) => {
  if (value.id === null && value.name === null) {
    context.addIssue({ code: "custom", message: "preset id or name is required" });
  }
});

function rectanglesEqual(left: SceneRectangle, right: SceneRectangle): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

const versionTwoInput = z.object({
  version: z.literal(2),
  sourceArtifactId: z.string().uuid().nullable().default(null),
  split: renderSplitSettings.default(() => ({ mode: "single" as const })),
  blur: blurSettings,
  voice: fixedVoice,
  rate,
  output: outputSettings.default(() => ({ format: "mp4" as const })),
  preset: presetMetadata.nullable().default(null),
  sourceSubtitle: rectangle.optional(),
  logo: rectangle.optional(),
}).strict().superRefine((value, context) => {
  const sourceSubtitle = value.blur.regions.find((region) => region.kind === "sourceSubtitle")?.rectangle;
  const logo = value.blur.regions.find((region) => region.kind === "logo")?.rectangle;

  if (sourceSubtitle && value.sourceSubtitle && !rectanglesEqual(sourceSubtitle, value.sourceSubtitle)) {
    context.addIssue({
      code: "custom",
      path: ["sourceSubtitle"],
      message: "sourceSubtitle alias conflicts with blur region",
    });
  }
  if (logo && value.logo && !rectanglesEqual(logo, value.logo)) {
    context.addIssue({
      code: "custom",
      path: ["logo"],
      message: "logo alias conflicts with blur region",
    });
  }
});

const versionTwoSchema = versionTwoInput.transform((value) => {
  const sourceSubtitle = value.blur.regions.find((region) => region.kind === "sourceSubtitle")!;
  const logo = value.blur.regions.find((region) => region.kind === "logo")!;

  return {
    version: value.version,
    sourceArtifactId: value.sourceArtifactId,
    split: value.split,
    blur: value.blur,
    voice: value.voice,
    rate: value.rate,
    output: value.output,
    preset: value.preset,
    sourceSubtitle: sourceSubtitle.rectangle,
    logo: logo.rectangle,
  };
});

const schema = z.union([versionTwoSchema, legacySchema]);

export type SceneRectangle = Readonly<z.infer<typeof rectangle>>;
export type SceneSettings = Readonly<z.infer<typeof schema>>;

export function parseSceneSettings(value: unknown): SceneSettings {
  return schema.parse(value);
}
