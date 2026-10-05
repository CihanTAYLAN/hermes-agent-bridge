import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacVerificationInput = {
  activeSecret: string;
  previousSecret: string | undefined;
  rawBody: Buffer;
  signature: string;
  timestamp: string;
};

export function signHmacV2(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(timestamp, 'utf8')
    .update('.', 'utf8')
    .update(rawBody)
    .digest('hex');
}

function compareHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (left.length !== 64 || right.length !== 64 || leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyHmacV2(input: HmacVerificationInput): boolean {
  const activeSignature = signHmacV2(input.activeSecret, input.timestamp, input.rawBody);
  const previousSignature = signHmacV2(
    input.previousSecret ?? '__bridge_missing_previous_secret__',
    input.timestamp,
    input.rawBody,
  );
  const activeMatches = compareHex(input.signature, activeSignature);
  const previousMatches = compareHex(input.signature, previousSignature);
  return activeMatches || (input.previousSecret !== undefined && previousMatches);
}
