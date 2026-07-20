import { describe, expect, it } from "vitest";
import { parseDriveResumableSessionUri } from "./resumable-session-uri";

describe("Drive resumable session URI", () => {
  it.each([
    "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque-capability",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?uploadType=resumable&upload_id=opaque-capability",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque-capability&uploadType=resumable",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?uploadType=resumable&upload_id=opaque-capability&session_crd=opaque-session-credential",
  ])("accepts an exact provider query shape %#", (value) => {
    expect(parseDriveResumableSessionUri(value)).toBe(value);
  });

  it.each([
    "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=one&upload_id=two",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque&unexpected=value",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque&access_token=value",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?uploadType=resumable&upload_id=opaque&session_crd=one&session_crd=two",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?uploadType=media&upload_id=opaque",
    "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque#fragment",
    "https://user@www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque",
  ])("rejects an unsafe provider URI %#", (value) => {
    expect(parseDriveResumableSessionUri(value)).toBeNull();
  });
});
