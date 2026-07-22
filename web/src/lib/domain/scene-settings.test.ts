import { describe, expect, it } from "vitest";
import { parseSceneSettings } from "./scene-settings";

const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.15 };

describe("scene settings", () => {
  it("accepts normalized static subtitle/logo rectangles and the fixed BV074 voice", () => {
    expect(parseSceneSettings({
      sourceSubtitle: rect,
      logo: { x: 0, y: 0, width: 0.2, height: 0.2 },
      voice: "BV074_streaming",
      rate: 1,
    })).toMatchObject({ voice: "BV074_streaming", rate: 1, version: 1, sourceArtifactId: null });
  });

  it("keeps the source artifact reference versioned for local-only review", () => {
    expect(parseSceneSettings({
      version: 1,
      sourceArtifactId: "10000000-0000-4000-8000-000000000001",
      sourceSubtitle: rect,
      logo: rect,
      voice: "BV074_streaming",
      rate: 0.95,
    })).toMatchObject({ version: 1, sourceArtifactId: "10000000-0000-4000-8000-000000000001" });
  });

  it.each(["vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"])(
    "normalizes the persisted Edge-era voice %s to BV074",
    (voice) => {
      expect(parseSceneSettings({
        sourceSubtitle: rect,
        logo: rect,
        voice,
        rate: 1,
      }).voice).toBe("BV074_streaming");
    },
  );

  it.each([
    { sourceSubtitle: { ...rect, x: 1.1 }, logo: rect, voice: "BV074_streaming", rate: 1 },
    { sourceSubtitle: { ...rect, width: 0 }, logo: rect, voice: "BV074_streaming", rate: 1 },
    { sourceSubtitle: rect, logo: rect, voice: "unknown", rate: 1 },
    { sourceSubtitle: rect, logo: rect, voice: "BV074_streaming", rate: 3 },
  ])("rejects unsafe scene settings", (value) => {
    expect(() => parseSceneSettings(value)).toThrow();
  });
});
