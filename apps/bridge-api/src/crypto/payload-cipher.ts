import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedPayload = {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
};

export class PayloadCipher {
  private readonly key: Buffer;

  constructor(
    key: Buffer,
    readonly keyId: string,
  ) {
    if (key.length !== 32) {
      throw new Error('AES-256-GCM key must be exactly 32 bytes');
    }
    if (keyId.length === 0) {
      throw new Error('Encryption key ID is required');
    }
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: Buffer, associatedEventId: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(associatedEventId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext,
      iv,
      tag: cipher.getAuthTag(),
      keyId: this.keyId,
    };
  }

  decrypt(payload: EncryptedPayload, associatedEventId: string): Buffer {
    if (payload.keyId !== this.keyId) {
      throw new Error(`Unknown encryption key ID: ${payload.keyId}`);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.iv);
    decipher.setAAD(Buffer.from(associatedEventId, 'utf8'));
    decipher.setAuthTag(payload.tag);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  }
}

export class PayloadCipherKeyring {
  private readonly decryptors: ReadonlyMap<string, PayloadCipher>;

  constructor(
    private readonly current: PayloadCipher,
    previous: readonly PayloadCipher[] = [],
  ) {
    this.decryptors = new Map(
      [current, ...previous].map((cipher) => [cipher.keyId, cipher] as const),
    );
    if (this.decryptors.size !== previous.length + 1) {
      throw new Error('Encryption key IDs must be unique');
    }
  }

  encrypt(plaintext: Buffer, associatedEventId: string): EncryptedPayload {
    return this.current.encrypt(plaintext, associatedEventId);
  }

  decrypt(payload: EncryptedPayload, associatedEventId: string): Buffer {
    const cipher = this.decryptors.get(payload.keyId);
    if (!cipher) {
      throw new Error(`Unknown encryption key ID: ${payload.keyId}`);
    }
    return cipher.decrypt(payload, associatedEventId);
  }
}
