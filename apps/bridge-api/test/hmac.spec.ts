import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyHmacV2 } from '../src/auth/hmac.js';

type HmacVector = {
  secret: string;
  timestamp: string;
  raw_body: string;
  expected_signature_v2: string;
};

type HmacVectors = { vectors: HmacVector[] };

const vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../contracts/hmac-v2.test-vectors.json'), 'utf8'),
) as HmacVectors;

describe('HMAC V2', () => {
  it('accepts the published raw-body test vector', () => {
    const vector = vectors.vectors[0];
    expect(vector).toBeDefined();
    if (!vector) return;

    expect(
      verifyHmacV2({
        activeSecret: vector.secret,
        previousSecret: undefined,
        rawBody: Buffer.from(vector.raw_body),
        signature: vector.expected_signature_v2,
        timestamp: vector.timestamp,
      }),
    ).toBe(true);
  });
});
