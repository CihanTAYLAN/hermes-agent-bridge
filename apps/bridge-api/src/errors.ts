export class BridgeError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'BridgeError';
  }
}
