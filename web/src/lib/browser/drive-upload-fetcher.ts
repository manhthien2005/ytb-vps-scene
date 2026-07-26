function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Google Drive's resumable browser sample uses XMLHttpRequest for media PUTs.
 * Keep this adapter deliberately small: the uploader only needs status and Range.
 */
export function createDriveUploadFetcher(): typeof fetch {
  const fetcher = (input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const signal = init.signal;
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", abortRequest);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abortRequest = () => xhr.abort();

    xhr.open(init.method ?? "GET", requestUrl(input), true);
    new Headers(init.headers).forEach((value, name) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.onload = () => finish(() => {
      const acknowledgedRange = xhr.getResponseHeader("range");
      const headers = {
        get(name: string) {
          return name.toLowerCase() === "range" ? acknowledgedRange : null;
        },
      } as Headers;
      resolve({
        status: xhr.status,
        type: "basic",
        headers,
      } as Response);
    });
    xhr.onerror = () => finish(() => reject(new TypeError("Failed to fetch")));
    xhr.onabort = () => finish(() => reject(new DOMException("The operation was aborted", "AbortError")));

    if (signal?.aborted) {
      // xhr.abort() before send() fires no event, so the promise would never
      // settle; reject immediately to match real fetch semantics.
      finish(() => reject(new DOMException("The operation was aborted", "AbortError")));
      return;
    }
    signal?.addEventListener("abort", abortRequest, { once: true });
    try {
      xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
    } catch (error) {
      finish(() => reject(error));
    }
  });
  return fetcher as typeof fetch;
}
