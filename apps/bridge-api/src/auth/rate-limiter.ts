export class AgentRateLimiter {
  private readonly buckets = new Map<string, { second: number; count: number }>();

  constructor(private readonly limitPerSecond: number) {
    if (!Number.isInteger(limitPerSecond) || limitPerSecond < 1) {
      throw new Error('rate limit must be a positive integer');
    }
  }

  tryConsume(agentId: string, now: Date): boolean {
    const second = Math.floor(now.getTime() / 1_000);
    const bucket = this.buckets.get(agentId);
    if (!bucket || bucket.second !== second) {
      this.buckets.set(agentId, { second, count: 1 });
      return true;
    }
    if (bucket.count >= this.limitPerSecond) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}
