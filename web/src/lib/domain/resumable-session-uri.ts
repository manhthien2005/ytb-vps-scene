const URI_MAX_BYTES = 4_096;
const UPLOAD_ID_MAX_BYTES = 2_048;
const FILE_SEGMENT = /^[A-Za-z0-9._~-]{1,512}$/;
const UPLOAD_ID = /^[A-Za-z0-9._~-]+$/;

function boundedAscii(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    /^[\x21-\x7E]+$/.test(value);
}

export function parseDriveResumableSessionUri(value: unknown): string | null {
  if (!boundedAscii(value, URI_MAX_BYTES)) return null;
  try {
    const uri = new URL(value);
    const pathPrefix = "/upload/drive/v3/files/";
    if (
      uri.protocol !== "https:" ||
      uri.hostname !== "www.googleapis.com" ||
      uri.port !== "" ||
      uri.username !== "" ||
      uri.password !== "" ||
      uri.hash !== "" ||
      !uri.pathname.startsWith(pathPrefix) ||
      !FILE_SEGMENT.test(uri.pathname.slice(pathPrefix.length))
    ) {
      return null;
    }

    const entries = [...uri.searchParams.entries()];
    const uploadIds = uri.searchParams.getAll("upload_id");
    const uploadTypes = uri.searchParams.getAll("uploadType");
    const queryShapeIsValid = (
      entries.length === 1 &&
      entries[0]?.[0] === "upload_id" &&
      uploadTypes.length === 0
    ) || (
      entries.length === 2 &&
      uploadIds.length === 1 &&
      uploadTypes.length === 1 &&
      uploadTypes[0] === "resumable" &&
      entries.every(([key]) => key === "upload_id" || key === "uploadType")
    );
    const uploadId = uploadIds[0];
    if (
      !queryShapeIsValid ||
      uploadIds.length !== 1 ||
      !boundedAscii(uploadId, UPLOAD_ID_MAX_BYTES) ||
      !UPLOAD_ID.test(uploadId)
    ) {
      return null;
    }
    return uri.toString();
  } catch {
    return null;
  }
}

export function isDriveResumableSessionUri(value: unknown): value is string {
  return parseDriveResumableSessionUri(value) !== null;
}
