import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly producer: Producer;
  private connected = false;

  constructor() {
    const kafka = new Kafka({
      clientId: 'orderflow-app',
      brokers: (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(','),
      retry: { retries: 3 },
    });
    this.producer = kafka.producer();
  }

  async onModuleInit() {
    try {
      await this.producer.connect();
      this.connected = true;
    } catch (err) {
      this.logger.warn(
        `Kafka producer failed to connect, event publishing disabled: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.connected) await this.producer.disconnect();
  }

  /**
   * Best-effort event publish. Must never throw or block the caller's business
   * transaction — if Kafka is unavailable, the app keeps working exactly as it
   * did before this producer existed.
   */
  async publish(topic: string, message: Record<string, unknown>): Promise<void> {
    if (!this.connected) return;
    try {
      await this.producer.send({
        topic,
        messages: [{ value: JSON.stringify(message) }],
      });
    } catch (err) {
      this.logger.warn(`Failed to publish to ${topic}: ${(err as Error).message}`);
    }
  }
}
