import type { FilePurposeValue } from '@dbb/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; quiet401?: boolean } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) unauthorizedListeners.forEach((l) => l());
    const d = (data ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code ?? 'error', d.details);
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>('GET', path, undefined, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const del = <T>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export interface UploadedFile {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  animated: boolean;
}

/** Upload with progress (fetch has no upload progress, so XHR it is). */
export function upload(
  purpose: FilePurposeValue,
  file: File | Blob,
  onProgress?: (fraction: number) => void,
  filename?: string,
): { promise: Promise<UploadedFile>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedFile>((resolve, reject) => {
    xhr.open('POST', `/api/files?purpose=${purpose}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string; code?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as UploadedFile);
      else reject(new ApiError(xhr.status, data.error ?? 'Upload failed', data.code ?? 'error'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error', 'network'));
    xhr.onabort = () => reject(new ApiError(0, 'Cancelled', 'aborted'));
    const fd = new FormData();
    fd.append('file', file, filename ?? (file instanceof File ? file.name : 'file'));
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
