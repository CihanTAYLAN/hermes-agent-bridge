import { readFileSync } from 'node:fs';
import Ajv2020Import, {
  type Ajv2020 as Ajv2020Instance,
  type Options,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { BridgeEvent } from '../domain.js';
import { BridgeError } from '../errors.js';

export class EventValidator {
  private readonly validate: ValidateFunction<BridgeEvent>;

  constructor() {
    const schemaUrl = new URL('../../../../contracts/event.v1.schema.json', import.meta.url);
    const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as object;
    const Ajv2020 = Ajv2020Import as unknown as new (options?: Options) => Ajv2020Instance;
    const addFormats = addFormatsImport as unknown as (
      instance: Ajv2020Instance,
    ) => Ajv2020Instance;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.validate = ajv.compile<BridgeEvent>(schema);
  }

  parse(rawBody: Buffer): BridgeEvent {
    let value: unknown;
    try {
      value = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new BridgeError(400, 'invalid_json');
    }
    if (!this.validate(value)) {
      throw new BridgeError(422, 'invalid_event');
    }
    return value;
  }
}
