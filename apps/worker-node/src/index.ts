import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '@loadtest/database/src/index';
import { Pool } from 'undici';
import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { performance } from 'perf_hooks';

const connection = new IORedis({ host: 'redis', port: 6379, maxRetriesPerRequest: null });
const influx = new InfluxDB({ url: 'http://influxdb:8086', token: 'supersecrettoken123' });
const writeApi = influx.getWriteApi('loadtest', 'metrics', 'ms');

console.log('[Worker] Booting up Chaos Engine...');
console.log('[Worker] Listening for jobs on Redis queue: load-test-queue');

const worker = new Worker('load-test-queue', async job => {
  const { scenarioId } = job.data;
  const scenario = await prisma.scenario.findUnique({ where: { id: scenarioId } });
  if (!scenario) throw new Error(`Scenario not found`);

  console.log(`\n[Worker] 🚀 Job ID: ${job.id} | Scenario: ${scenario.name}`);
  if (scenario.addedLatency > 0 || scenario.errorRate > 0) {
    console.log(`[Worker] ⚠️ CHAOS MODE ACTIVE! Latency: +${scenario.addedLatency}ms | Drop Rate: ${scenario.errorRate * 100}%`);
  }

  const targetUrl = new URL(scenario.targetUrl);
  const pool = new Pool(targetUrl.origin, { connections: scenario.virtualUsers * 2 });
  const path = targetUrl.pathname + targetUrl.search;
  
  const endTime = Date.now() + (scenario.durationSec * 1000);
  let totalRequests = 0;
  let successCount = 0;

  let pointsBatch: Point[] = [];
  const flushInterval = setInterval(() => {
    if (pointsBatch.length > 0) {
      writeApi.writePoints(pointsBatch);
      pointsBatch = []; 
    }
  }, 1000); 

  const runVirtualUser = async () => {
    while (Date.now() < endTime) {
      const start = performance.now();
      let status = 0;
      let errorType = 'none';

      try {
        // --- 🌪️ CHAOS INJECTION: Artificial Latency ---
        if (scenario.addedLatency > 0) {
          await new Promise(resolve => setTimeout(resolve, scenario.addedLatency));
        }

        // --- 🌪️ CHAOS INJECTION: Packet Drop / Network Failure ---
        if (scenario.errorRate > 0 && Math.random() < scenario.errorRate) {
          throw { code: 'ERR_CHAOS_DROP' };
        }

        const response = await pool.request({
          path,
          method: scenario.method as any,
          headers: scenario.headers ? JSON.parse(scenario.headers) : undefined,
        });
        status = response.statusCode;
        if (status >= 200 && status < 400) successCount++;
        await response.body.dump(); 
      } catch (e: any) {
        status = 500;
        errorType = e.code || 'UNKNOWN';
      }

      const latency = performance.now() - start;
      totalRequests++;

      const point = new Point('request')
        .tag('scenarioId', scenarioId)
        .tag('jobId', String(job.id))
        .tag('status', String(status))
        .tag('error', errorType)
        .floatField('latency', latency);
      
      pointsBatch.push(point);
    }
  };

  const vus = [];
  for (let i = 0; i < scenario.virtualUsers; i++) {
    vus.push(runVirtualUser());
  }

  await Promise.all(vus);

  clearInterval(flushInterval);
  if (pointsBatch.length > 0) writeApi.writePoints(pointsBatch);
  await writeApi.flush();

  console.log(`[Worker] ✅ Job ${job.id} Complete! RPS: ${Math.round(totalRequests / scenario.durationSec)}`);
  return { totalRequests, successCount };
}, { connection });

worker.on('error', err => console.error('[Worker] Error:', err));