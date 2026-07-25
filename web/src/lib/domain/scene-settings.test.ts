import { describe, expect, it } from "vitest";
import { parseSceneSettings } from "./scene-settings";

const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.15 };
const subtitle = { x: 0.05, y: 0.78, width: 0.9, height: 0.16 };
const logo = { x: 0.78, y: 0.04, width: 0.18, height: 0.16 };
const custom = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };
const sourceArtifactId = "10000000-0000-4000-8000-000000000001";
const presetId = "20000000-0000-4000-8000-000000000002";

const completeV2 = {
  version: 2,
  sourceArtifactId,
  split: { mode: "fixedSeconds", secondsPerPart: 900 },
  blur: {
    mode: "auto",
    regions: [
      { kind: "sourceSubtitle", enabled: true, rectangle: subtitle },
      { kind: "logo", enabled: false, rectangle: logo },
      { kind: "custom", enabled: true, rectangle: custom },
    ],
  },
  voice: "BV074_streaming",
  rate: 1,
  output: { format: "mp4" },
  preset: { id: presetId, name: "Vietnamese portrait" },
};

describe("scene settings", () => {
  it("accepts normalized v1 rectangles and fills the legacy defaults", () => {
    expect(parseSceneSettings({
      sourceSubtitle: rect,
      logo: { x: 0, y: 0, width: 0.2, height: 0.2 },
      voice: "BV074_streaming",
      rate: 1,
    })).toEqual({
      version: 1,
      sourceArtifactId: null,
      sourceSubtitle: rect,
      logo: { x: 0, y: 0, width: 0.2, height: 0.2 },
      voice: "BV074_streaming",
      rate: 1,
    });
  });

  it("keeps the v1 source artifact reference", () => {
    expect(parseSceneSettings({
      version: 1,
      sourceArtifactId,
      sourceSubtitle: rect,
      logo: rect,
      voice: "BV074_streaming",
      rate: 0.95,
    })).toMatchObject({ version: 1, sourceArtifactId });
  });

  it.each(["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"])(
    "normalizes the persisted Edge-era voice %s in v1 and v2",
    (voice) => {
      expect(parseSceneSettings({
        sourceSubtitle: rect,
        logo: rect,
        voice,
        rate: 1,
      }).voice).toBe("BV074_streaming");
      expect(parseSceneSettings({
        ...completeV2,
        voice,
      }).voice).toBe("BV074_streaming");
    },
  );

  it("parses complete v2 settings and derives current-worker rectangle aliases", () => {
    expect(parseSceneSettings(completeV2)).toEqual({
      ...completeV2,
      sourceSubtitle: subtitle,
      logo,
    });
  });

  it("fills deterministic v2 split, output, source, and preset defaults", () => {
    expect(parseSceneSettings({
      version: 2,
      blur: {
        mode: "manual",
        regions: [
          { kind: "sourceSubtitle", enabled: true, rectangle: subtitle },
          { kind: "logo", enabled: true, rectangle: logo },
        ],
      },
      voice: "BV074_streaming",
      rate: 0.8,
    })).toEqual({
      version: 2,
      sourceArtifactId: null,
      split: { mode: "single" },
      blur: {
        mode: "manual",
        regions: [
          { kind: "sourceSubtitle", enabled: true, rectangle: subtitle },
          { kind: "logo", enabled: true, rectangle: logo },
        ],
      },
      voice: "BV074_streaming",
      rate: 0.8,
      output: { format: "mp4" },
      preset: null,
      sourceSubtitle: subtitle,
      logo,
    });
  });

  it.each([1, 86_400])("accepts fixed split duration boundary %i", (secondsPerPart) => {
    expect(parseSceneSettings({
      ...completeV2,
      split: { mode: "fixedSeconds", secondsPerPart },
    })).toMatchObject({ split: { mode: "fixedSeconds", secondsPerPart } });
  });

  it.each([0, 1.5, 86_401])("rejects invalid fixed split duration %s", (secondsPerPart) => {
    expect(() => parseSceneSettings({
      ...completeV2,
      split: { mode: "fixedSeconds", secondsPerPart },
    })).toThrow();
  });

  it("rejects unknown split modes and extra single-mode duration data", () => {
    expect(() => parseSceneSettings({
      ...completeV2,
      split: { mode: "chapters" },
    })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      split: { mode: "single", secondsPerPart: 900 },
    })).toThrow();
  });

  it.each([
    { sourceSubtitle: { ...rect, x: 1.1 }, logo: rect, voice: "BV074_streaming", rate: 1 },
    { sourceSubtitle: { ...rect, width: 0 }, logo: rect, voice: "BV074_streaming", rate: 1 },
    { sourceSubtitle: rect, logo: rect, voice: "unknown", rate: 1 },
    { sourceSubtitle: rect, logo: rect, voice: "BV074_streaming", rate: 3 },
  ])("rejects unsafe v1 scene settings", (value) => {
    expect(() => parseSceneSettings(value)).toThrow();
  });

  it("rejects unsafe normalized rectangles in v2, even for disabled regions", () => {
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: {
        mode: "manual",
        regions: [
          { kind: "sourceSubtitle", enabled: false, rectangle: { ...subtitle, width: 0.96 } },
          { kind: "logo", enabled: true, rectangle: logo },
        ],
      },
    })).toThrow();
  });

  it("rejects unknown blur modes and region kinds", () => {
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: { ...completeV2.blur, mode: "hybrid" },
    })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: {
        ...completeV2.blur,
        regions: [
          ...completeV2.blur.regions,
          { kind: "face", enabled: true, rectangle: custom },
        ],
      },
    })).toThrow();
  });

  it("rejects more than eight blur regions", () => {
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: {
        mode: "manual",
        regions: [
          { kind: "sourceSubtitle", enabled: true, rectangle: subtitle },
          { kind: "logo", enabled: true, rectangle: logo },
          ...Array.from({ length: 7 }, () => ({ kind: "custom", enabled: true, rectangle: custom })),
        ],
      },
    })).toThrow();
  });

  it.each(["sourceSubtitle", "logo"])("rejects duplicate required %s regions", (kind) => {
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: {
        ...completeV2.blur,
        regions: [
          ...completeV2.blur.regions,
          { kind, enabled: true, rectangle: custom },
        ],
      },
    })).toThrow();
  });

  it.each(["sourceSubtitle", "logo"])("requires a %s manual fallback region", (kind) => {
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: {
        ...completeV2.blur,
        regions: completeV2.blur.regions.filter((region) => region.kind !== kind),
      },
    })).toThrow();
  });

  it("rejects supplied worker aliases that conflict with canonical regions", () => {
    expect(() => parseSceneSettings({
      ...completeV2,
      sourceSubtitle: custom,
      logo,
    })).toThrow();
  });

  it("accepts canonical v2 output again without changing it", () => {
    const parsed = parseSceneSettings(completeV2);
    expect(parseSceneSettings(parsed)).toEqual(parsed);
  });

  it("rejects unknown voices and output formats in v2", () => {
    expect(() => parseSceneSettings({
      ...completeV2,
      voice: "voice-from-client",
    })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      output: { format: "mkv" },
    })).toThrow();
  });

  it("supports bounded preset references and name-only drafts", () => {
    expect(parseSceneSettings({
      ...completeV2,
      preset: { id: presetId },
    })).toMatchObject({ preset: { id: presetId, name: null } });
    expect(parseSceneSettings({
      ...completeV2,
      preset: { name: "Portrait" },
    })).toMatchObject({ preset: { id: null, name: "Portrait" } });
  });

  it.each(["", " ", "p".repeat(101)])("rejects empty or oversized preset name %j", (name) => {
    expect(() => parseSceneSettings({
      ...completeV2,
      preset: { id: presetId, name },
    })).toThrow();
  });

  it("rejects empty, malformed, and oversized preset references", () => {
    expect(() => parseSceneSettings({ ...completeV2, preset: {} })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      preset: { id: "preset-1", name: "Preset" },
    })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      preset: { id: "x".repeat(1_000), name: "Preset" },
    })).toThrow();
  });

  it("rejects unknown keys at every persisted object boundary", () => {
    expect(() => parseSceneSettings({ ...completeV2, extra: true })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: { ...completeV2.blur, extra: true },
    })).toThrow();
    expect(() => parseSceneSettings({
      ...completeV2,
      blur: {
        ...completeV2.blur,
        regions: [
          { kind: "sourceSubtitle", enabled: true, rectangle: { ...subtitle, unit: "pixels" } },
          { kind: "logo", enabled: true, rectangle: logo },
        ],
      },
    })).toThrow();
  });

  it("keeps a maximum accepted route payload below 4096 bytes", () => {
    const parsed = parseSceneSettings({
      ...completeV2,
      blur: {
        mode: "auto",
        regions: [
          { kind: "sourceSubtitle", enabled: true, rectangle: subtitle },
          { kind: "logo", enabled: false, rectangle: logo },
          ...Array.from({ length: 6 }, () => ({ kind: "custom", enabled: true, rectangle: custom })),
        ],
      },
      preset: { id: presetId, name: "界".repeat(100) },
    });
    expect(Buffer.byteLength(JSON.stringify({ settings: parsed }), "utf8")).toBeLessThan(4_096);
  });

  it("does not mutate caller-owned settings while normalizing them", () => {
    const v2Input = structuredClone(completeV2);
    parseSceneSettings(v2Input);
    expect(v2Input).toEqual(completeV2);
    expect(v2Input).not.toHaveProperty("sourceSubtitle");
    expect(v2Input).not.toHaveProperty("logo");

    const v1Input = {
      sourceSubtitle: rect,
      logo: rect,
      voice: "vi-VN-HoaiMyNeural",
      rate: 1,
    };
    parseSceneSettings(v1Input);
    expect(v1Input.voice).toBe("vi-VN-HoaiMyNeural");
    expect(v1Input).not.toHaveProperty("version");
  });
});
