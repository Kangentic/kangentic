export interface RetryOptions {
  maxRetries: number;
  backoff: 'linear' | 'exponential';
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWithBackoff<T>(request: () => Promise<T>, options: RetryOptions): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 200;
  let attempt = 0;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      attempt += 1;
      if (attempt > options.maxRetries) throw error;
      const delay = options.backoff === 'exponential' ? baseDelayMs * 2 ** (attempt - 1) : baseDelayMs * attempt;
      await sleep(delay);
    }
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return retryWithBackoff(async () => {
    const response = await fetch(`/api${path}`, init);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  }, { maxRetries: 3, backoff: 'exponential' });
}
