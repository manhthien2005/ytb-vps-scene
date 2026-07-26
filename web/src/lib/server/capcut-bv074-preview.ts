import "server-only";

import { createHash, publicEncrypt, constants, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";

const BASE = "https://editor-api-sg.capcutapi.com";
export const CAPCUT_BV074_VOICE = "BV074_streaming";
export const CAPCUT_BV074_RESOURCE_ID = "7102355709945188865";

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmTd34Lw4b7IuldSXh/zY
CMla+ITdGG5TeWz6ad+OySd4r+IrY45AoqrYUxhQ2dl+7z+i7r/5vEa8rr39BYfB
8AGMQLmZA8HmgpWBsqrn/V6daUALkKnkLb70Fn32CJigIuGXAYqxUdGuI340aC+0
v5Es3puJsHyzf01/AelE4Cdc6bZhQrASJLBh8R3BQToYClmDVSDUQk28o8sl/guA
Z4n303Vj+6Siv1HayPCdV6kpVVnMBAG4+umUbwGmn132N3fgpzLarFF3XyWmS1zh
D/J07iM/rP8GDO9IskHNHd2phrO0G6KzrcFAnTBHjVv+hCBEfzN/no3FNA9AuC36
mwIDAQAB
-----END PUBLIC KEY-----`;

const DEFAULT_DEVICE = {
  aid: "359289",
  app_name: "CapCut",
  appvr: "8.7.0",
  version_name: "8.7.0",
  version_code: "8.7.0",
  channel: "capcutpc_google",
  device_platform: "mac",
  device_type: "MacBookPro17,1",
  device_brand: "MacBookPro17,1",
  os_version: "15.7.4",
  region: "VN",
  loc: "VN",
  lan: "vi-VN",
  pf: "3",
} as const;

type DefaultDeviceKey = keyof typeof DEFAULT_DEVICE | "device_id" | "iid" | "tdid";
type Device = Record<DefaultDeviceKey, string> & Record<string, string>;
type Address = Readonly<{ address: string; family: number }>;
type DownloadOptions = Readonly<{ timeoutMs: number; maxBytes: number }>;
type PreviewDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
  downloadAudioImpl?: (url: URL, address: Address, options: DownloadOptions) => Promise<Uint8Array>;
  sleep?: (milliseconds: number) => Promise<unknown> | unknown;
  requestTimeoutMs?: number;
  audioTimeoutMs?: number;
  maxAudioBytes?: number;
}>;

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function rsaEncryptPkcs1v15(value: string): string {
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value, "utf8")).toString("base64");
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function commonQuery(device: Device, babiParam?: unknown, includeRegion = true): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of ["app_name", "device_type", "os_version", "channel", "version_name", "device_brand", "device_id", "iid", "version_code", "device_platform", "aid"] as const) {
    query.set(key, device[key]);
  }
  if (includeRegion) query.set("region", device.region);
  if (babiParam !== undefined) query.set("babi_param", compactJson(babiParam));
  return query;
}

function headers(device: Device, url: string, bodyText: string): HeadersInit {
  const now = String(Math.floor(Date.now() / 1000));
  const trace = randomUUID().replaceAll("-", "").slice(0, 32);
  const path = url.split("?", 1)[0]!;
  return {
    "content-type": "application/json",
    appvr: device.appvr,
    ch: device.channel,
    "device-time": now,
    lan: device.lan,
    loc: device.loc,
    pf: device.pf,
    "sign-ver": "1",
    tdid: device.tdid,
    "x-ss-stub": md5(bodyText),
    "x-ss-dp": device.aid,
    "x-khronos": now,
    "x-tt-trace-id": `00-${trace}-${trace.slice(0, 16)}-01`,
    "user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16",
    "accept-encoding": "gzip, deflate",
    "store-country-code": device.loc.toLowerCase(),
    "store-country-code-src": "did",
    "is-dispatch-us-ttp": "0",
    "is-app-region-us-ttp": "0",
    "app-sdk-version": device.appvr,
    appid: device.aid,
    sign: md5(`9e2c|${path.slice(-7)}|3|${device.appvr}|${now}|${device.tdid}|11ac`),
  };
}

function makeNewBody(text: string, rate: number, device: Device) {
  const babi = {
    feature_entrance: "editor",
    feature_entrance_detail: "editor-feature-text_to_speech",
    feature_key: "text_to_speech",
    scenario: "video_editor",
  };
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\n    <voice name="${CAPCUT_BV074_VOICE}" mock_tone_info="" platform="sami" resource_id="${CAPCUT_BV074_RESOURCE_ID}" emotion="" emotion_scale="0" style="" role="" moyin_emotion="" is_clone_tone="false" need_subtitle_timestamp="false">\n        <prosody rate="${String(rate)}">${xmlEscape(text)}</prosody>\n    </voice>\n</speak>`;
  const extra = compactJson({ benefit_info: {} });
  const payload: Record<string, unknown> = {
    audio_format: "mp3",
    babi_param: compactJson(babi),
    credit_disable: false,
    extra_info: extra,
    need_merge_voice: false,
    need_subtitle_timestamp: false,
    scene: "text_to_speech",
    ssml,
  };
  payload.sign = rsaEncryptPkcs1v15(`appid:${device.aid}&did:${device.device_id}&creditDisable:false&ssml:${md5(ssml)}&extraInfo:${extra}`);
  return {
    babi,
    body: {
      bind_id: randomUUID(),
      can_queue: true,
      enter_from: "text_to_speech",
      tasks: [{ context: randomUUID(), payload: compactJson(payload), req_key: "sami_text_to_speech", task_version: "v3" }],
    },
  };
}

function task(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const root = data as { data?: { tasks?: unknown[] } };
  const first = root.data?.tasks?.[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : {};
}

function firstAudioUrl(value: unknown): string | null {
  // Only surface candidates safeAudioTarget can accept (https-only): matching an
  // http entry first would discard a viable https backup URL later in the payload.
  if (typeof value === "string" && value.startsWith("https://")) return value;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = firstAudioUrl(nested);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      const found = firstAudioUrl(nested);
      if (found) return found;
    }
  }
  return null;
}

const MAX_PROVIDER_JSON_BYTES = 262_144;

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("CAPCUT_REQUEST_FAILED");
    return JSON.parse(text) as unknown;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("CAPCUT_REQUEST_FAILED");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function postJson(url: string, body: unknown, device: Device, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const bodyText = compactJson(body);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: headers(device, url, bodyText),
      body: bodyText,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("CAPCUT_REQUEST_FAILED");
    // await + bounded read: body/parse failures must map to the stable code, and an
    // untrusted endpoint must not stream an arbitrarily large body into memory.
    return await readBoundedJson(response, MAX_PROVIDER_JSON_BYTES);
  } catch {
    throw new Error("CAPCUT_REQUEST_FAILED");
  }
}

function publicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function safeAudioTarget(value: string, lookupImpl: typeof lookup): Promise<Readonly<{ url: URL; address: Address }>> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("CAPCUT_AUDIO_URL_UNSAFE");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!["tiktokcdn.com", "bytecdn.com", "byteoversea.com", "bytedance.com", "bytedance.net", "capcutapi.com"].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new Error("CAPCUT_AUDIO_HOST_REJECTED");
  }
  const addresses = await lookupImpl(hostname, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address))) throw new Error("CAPCUT_AUDIO_HOST_PRIVATE");
  const address = addresses[0]!;
  return { url, address: { address: address.address, family: address.family } };
}

export function createPinnedHttpsDownloader(requestImpl: typeof httpsRequest = httpsRequest) {
  return async function download(url: URL, address: Address, options: DownloadOptions): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error(code));
    };
    const agent = new Agent({
      lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (lookupOptions?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as never,
    });
    const request = requestImpl(url, {
      method: "GET",
      agent,
      headers: { "user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        fail(status >= 300 && status < 400 ? "CAPCUT_AUDIO_REDIRECT_REJECTED" : "CAPCUT_AUDIO_DOWNLOAD_FAILED");
        return;
      }
      const declared = Number(response.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.destroy();
        fail("CAPCUT_AUDIO_INVALID");
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          response.destroy();
          fail("CAPCUT_AUDIO_INVALID");
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const audio = Buffer.concat(chunks, size);
        if (audio.byteLength < 128) reject(new Error("CAPCUT_AUDIO_INVALID"));
        else resolve(new Uint8Array(audio));
      });
      response.once("error", () => fail("CAPCUT_AUDIO_DOWNLOAD_FAILED"));
    });
    request.once("error", (error) => fail(error.message === "CAPCUT_AUDIO_TIMEOUT" ? "CAPCUT_AUDIO_TIMEOUT" : "CAPCUT_AUDIO_DOWNLOAD_FAILED"));
    const deadline = setTimeout(() => request.destroy(new Error("CAPCUT_AUDIO_TIMEOUT")), options.timeoutMs);
    request.end();
    });
  };
}

const downloadPinnedHttpsAudio = createPinnedHttpsDownloader();

async function loadDevice(): Promise<Device> {
  const inline = process.env.CAPCUT_DEVICE_JSON_V1;
  const path = process.env.CAPCUT_DEVICE_PATH_V1;
  let raw: unknown;
  if (inline?.trim()) {
    const trimmed = inline.trim();
    try {
      const text = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
      raw = JSON.parse(text);
    } catch {
      // Never let a raw SyntaxError escape: V8 embeds a snippet of the parsed
      // source, which here is credential material.
      throw new Error("CAPCUT_DEVICE_INVALID");
    }
  } else if (path?.trim()) {
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("CAPCUT_DEVICE_INVALID");
    }
  } else {
    throw new Error("CAPCUT_DEVICE_MISSING");
  }
  if (!raw || typeof raw !== "object") throw new Error("CAPCUT_DEVICE_INVALID");
  const item = raw as Record<string, unknown>;
  for (const key of ["device_id", "iid", "tdid"] as const) {
    if (typeof item[key] !== "string" || !item[key]) throw new Error("CAPCUT_DEVICE_INVALID");
  }
  const device: Device = {
    ...DEFAULT_DEVICE,
    device_id: item.device_id as string,
    iid: item.iid as string,
    tdid: item.tdid as string,
  };
  for (const [key, value] of Object.entries(item)) if (typeof value === "string") device[key] = value;
  return device;
}

export function createCapCutBv074Preview(dependencies: PreviewDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const lookupImpl = dependencies.lookupImpl ?? lookup;
  const downloadAudioImpl = dependencies.downloadAudioImpl ?? downloadPinnedHttpsAudio;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? 15_000;
  const audioTimeoutMs = dependencies.audioTimeoutMs ?? 30_000;
  const maxAudioBytes = dependencies.maxAudioBytes ?? 50 * 1024 * 1024;

  return async function synthesize(text: string, rate: number): Promise<Uint8Array> {
    const device = await loadDevice();
    const { babi, body } = makeNewBody(text, rate, device);
    const newUrl = `${BASE}/lv/v1/common_task/new?${commonQuery(device, babi, true).toString()}`;
    const newData = await postJson(newUrl, body, device, fetchImpl, requestTimeoutMs);
    const created = task(newData);
    if ((newData as { ret?: unknown }).ret !== "0" || typeof created.id !== "string" || typeof created.token !== "string") throw new Error("CAPCUT_TASK_REJECTED");
    const queryUrl = `${BASE}/lv/v1/common_task/query?${commonQuery(device, undefined, false).toString()}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const queryData = await postJson(queryUrl, { tasks: [{ bind_id: "", id: created.id, req_key: "sami_text_to_speech", task_version: "v3", token: created.token }] }, device, fetchImpl, requestTimeoutMs);
      // A non-zero envelope or a terminal task failure will never become "succeed":
      // fail fast instead of burning the full 20-attempt window on a dead task.
      if ((queryData as { ret?: unknown }).ret !== "0") throw new Error("CAPCUT_TASK_REJECTED");
      const queried = task(queryData);
      if (typeof queried.status === "string" && ["failed", "fail", "cancelled", "canceled"].includes(queried.status)) {
        throw new Error("CAPCUT_TASK_REJECTED");
      }
      if (queried.status === "succeed" && typeof queried.payload === "string") {
        let payload: unknown;
        try {
          payload = JSON.parse(queried.payload);
        } catch {
          throw new Error("CAPCUT_AUDIO_MISSING");
        }
        const audioUrl = firstAudioUrl(payload);
        if (!audioUrl) throw new Error("CAPCUT_AUDIO_MISSING");
        const target = await safeAudioTarget(audioUrl, lookupImpl);
        return downloadAudioImpl(target.url, target.address, { timeoutMs: audioTimeoutMs, maxBytes: maxAudioBytes });
      }
      if (attempt < 19) await sleep(1000);
    }
    throw new Error("CAPCUT_QUERY_TIMEOUT");
  };
}

export const synthesizeCapCutBv074Preview = createCapCutBv074Preview();
