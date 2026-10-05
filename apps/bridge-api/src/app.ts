import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  type DynamicModule,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Module,
  Post,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BridgeOptions } from './config.js';
import { BridgeError } from './errors.js';
import { EventsService } from './events/events.service.js';
import { HeartbeatService } from './heartbeat/heartbeat.service.js';
import { BridgeMetrics } from './observability/metrics.js';

const BRIDGE_OPTIONS = Symbol('BRIDGE_OPTIONS');

function requestHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function asHttpException(error: unknown): never {
  if (error instanceof BridgeError) {
    throw new HttpException(
      { error: 'bridge_request_rejected', reason: error.reason },
      error.statusCode,
    );
  }
  throw error;
}

@Controller('/v1/events')
class EventsController {
  private readonly service: EventsService;

  constructor(
    @Inject(BRIDGE_OPTIONS) options: BridgeOptions,
    @Inject(BridgeMetrics) private readonly metrics: BridgeMetrics,
  ) {
    this.service = new EventsService(options);
  }

  @Post()
  @HttpCode(202)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ event_id: string; status: 'accepted' }> {
    const rawBody = request.rawBody;
    if (!rawBody) {
      this.metrics.eventRejected('raw_body_unavailable');
      throw new HttpException(
        { error: 'bridge_request_rejected', reason: 'raw_body_unavailable' },
        400,
      );
    }
    try {
      const result = await this.service.ingest(rawBody, {
        agentId: requestHeader(request, 'x-bridge-agent'),
        timestamp: requestHeader(request, 'x-webhook-timestamp'),
        signature: requestHeader(request, 'x-webhook-signature-v2'),
        requestId: requestHeader(request, 'x-request-id'),
      });
      this.metrics.eventReceived();
      return result;
    } catch (error) {
      if (error instanceof BridgeError) {
        this.metrics.eventRejected(error.reason);
      }
      return asHttpException(error);
    }
  }
}

@Controller('/v1/agents/heartbeat')
class HeartbeatController {
  private readonly service: HeartbeatService;

  constructor(@Inject(BRIDGE_OPTIONS) options: BridgeOptions) {
    this.service = new HeartbeatService(options);
  }

  @Post()
  @HttpCode(204)
  async receive(@Req() request: RawBodyRequest<FastifyRequest>): Promise<void> {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new HttpException(
        { error: 'bridge_request_rejected', reason: 'raw_body_unavailable' },
        400,
      );
    }
    try {
      await this.service.handle(
        requestHeader(request, 'x-bridge-agent'),
        requestHeader(request, 'x-webhook-timestamp'),
        requestHeader(request, 'x-webhook-signature-v2'),
        rawBody,
      );
    } catch (error) {
      return asHttpException(error);
    }
  }
}

@Controller()
class OperationsController {
  constructor(
    @Inject(BRIDGE_OPTIONS) private readonly options: BridgeOptions,
    @Inject(BridgeMetrics) private readonly metrics: BridgeMetrics,
  ) {}

  @Get('/healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('/readyz')
  async readiness(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: 'ready' | 'not_ready' }> {
    const ready = (await this.options.store.readiness()) && this.options.runtimeReadiness();
    if (!ready) {
      reply.status(503);
      return { status: 'not_ready' };
    }
    return { status: 'ready' };
  }

  @Get('/metrics')
  async getMetrics(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    if (!bearerMatches(authorization, this.options.metricsToken)) {
      throw new HttpException({ error: 'unauthorized' }, 401);
    }
    reply.header('content-type', this.metrics.contentType);
    return this.metrics.render();
  }
}

function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

@Module({})
class BridgeModule {
  static register(options: BridgeOptions): DynamicModule {
    return {
      module: BridgeModule,
      controllers: [EventsController, HeartbeatController, OperationsController],
      providers: [BridgeMetrics, { provide: BRIDGE_OPTIONS, useValue: options }],
    };
  }
}

export async function createBridgeApp(options: BridgeOptions): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ bodyLimit: options.maxBodyBytes });
  const app = await NestFactory.create<NestFastifyApplication>(
    BridgeModule.register(options),
    adapter,
    {
      logger: ['error'],
      rawBody: true,
    },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
