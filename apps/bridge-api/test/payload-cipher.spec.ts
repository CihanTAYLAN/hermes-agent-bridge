import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayloadCipher, PayloadCipherKeyring } from '../src/crypto/payload-cipher.js';

const key = randomBytes(32);
const plaintext = Buffer.from('{"message":{"text":"classified content"}}');

describe('PayloadCipher', () => {
  it('round-trips with AES-256-GCM without persisting plaintext', () => {
    const cipher = new PayloadCipher(key, 'test-key');

    const encrypted = cipher.encrypt(plaintext, 'event-1');

    expect(encrypted.ciphertext.includes(Buffer.from('classified content'))).toBe(false);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.tag).toHaveLength(16);
    expect(encrypted.keyId).toBe('test-key');
    expect(cipher.decrypt(encrypted, 'event-1')).toEqual(plaintext);
  });

  it('rejects ciphertext or associated-data tampering', () => {
    const cipher = new PayloadCipher(key, 'test-key');
    const encrypted = cipher.encrypt(plaintext, 'event-1');
    const firstByte = encrypted.ciphertext.at(0);
    expect(firstByte).toBeDefined();
    encrypted.ciphertext[0] = (firstByte ?? 0) ^ 1;

    expect(() => cipher.decrypt(encrypted, 'event-1')).toThrow();
    const intact = cipher.encrypt(plaintext, 'event-1');
    expect(() => cipher.decrypt(intact, 'different-event')).toThrow();
  });

  it('decrypts old payloads during key rotation but encrypts with the current key', () => {
    const previous = new PayloadCipher(randomBytes(32), 'previous');
    const current = new PayloadCipher(randomBytes(32), 'current');
    const keyring = new PayloadCipherKeyring(current, [previous]);
    const oldPayload = previous.encrypt(plaintext, 'event-1');

    expect(keyring.encrypt(plaintext, 'event-2').keyId).toBe('current');
    expect(keyring.decrypt(oldPayload, 'event-1')).toEqual(plaintext);
    expect(() => keyring.decrypt({ ...oldPayload, keyId: 'unknown' }, 'event-1')).toThrow(
      'Unknown encryption key ID',
    );
  });

  it('rejects non-256-bit encryption keys', () => {
    expect(() => new PayloadCipher(randomBytes(31), 'bad-key')).toThrow('32 bytes');
  });
});
