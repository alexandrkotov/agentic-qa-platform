import 'dotenv/config';
import { Kafka, type Consumer } from 'kafkajs';

const kafka = new Kafka({
  clientId: 'orderflow-tests',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
});

const admin = kafka.admin();

// Unique group per test run (not a fixed id) so this suite only ever sees
// messages produced during its own run — no committed offset carried over
// from a previous run to cause replay noise or skip-ahead misses.
const consumer: Consumer = kafka.consumer({ groupId: `orderflow-tests-${Date.now()}` });

const messagesByTopic = new Map<string, Record<string, unknown>[]>();

let ready: Promise<void> | null = null;

/** Connects once, ensures the given topics exist, subscribes from the
 * current end (fromBeginning: false), and waits for the consumer group to
 * actually be assigned partitions before resolving — so callers can rely on
 * messages produced right after this resolves being seen, not lost to a
 * rebalance still in progress.
 *
 * Explicitly creates topics via the Admin API first rather than relying on
 * broker auto-creation: subscribing to a topic that doesn't exist yet always
 * fails on the *first* attempt (auto-creation happens as a side effect of
 * that failed call, not before it) — on a freshly started, empty broker
 * (exactly what CI always has, since Kafka here is intentionally not
 * persisted across rebuilds) that first attempt is this call, every time. */
export function ensureKafkaConsumerReady(topics: string[]): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await admin.connect();
      await admin.createTopics({
        topics: topics.map((topic) => ({ topic, numPartitions: 1 })),
        waitForLeaders: true,
      });
      await admin.disconnect();

      await consumer.connect();
      for (const topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: false });
        messagesByTopic.set(topic, []);
      }

      const joined = new Promise<void>((resolve) => {
        consumer.on(consumer.events.GROUP_JOIN, () => resolve());
      });

      await consumer.run({
        eachMessage: async ({ topic, message }) => {
          if (!message.value) return;
          messagesByTopic.get(topic)?.push(JSON.parse(message.value.toString()));
        },
      });

      await joined;
    })();
  }
  return ready;
}

/** Polls the in-memory buffer for a message matching `predicate`, throwing
 * if none arrives within `timeoutMs`. */
export async function waitForKafkaMessage(
  topic: string,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messagesByTopic.get(topic)?.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No message on topic "${topic}" matched the expected predicate within ${timeoutMs}ms`);
}
