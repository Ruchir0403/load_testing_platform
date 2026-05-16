import { Router, Request, Response } from 'express';
import { prisma } from '@loadtest/database/src/index';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { InfluxDB } from '@influxdata/influxdb-client';

const router = Router();

const connection = new IORedis({ host: 'localhost', port: 6379, maxRetriesPerRequest: null });
const loadTestQueue = new Queue('load-test-queue', { connection });

// InfluxDB Setup for Querying
const influx = new InfluxDB({ url: 'http://localhost:8086', token: 'supersecrettoken123' });
const queryApi = influx.getQueryApi('loadtest');

router.post('/', async (req: Request, res: Response) => { /* ... existing ... */ });
router.get('/', async (req: Request, res: Response) => { /* ... existing ... */ });

router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const scenarioId = req.params.id;
    const scenario = await prisma.scenario.findUnique({ where: { id: scenarioId } });
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

    const job = await loadTestQueue.add('execute-test', { scenarioId });
    res.json({ message: 'Test queued successfully', jobId: job.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to queue test' });
  }
});

// NEW: Fetch Metrics for a specific Job
router.get('/:id/metrics/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    
    // Flux query to calculate avg, max, and p95 latency for a specific job
    const fluxQuery = `
      from(bucket: "metrics")
        |> range(start: -1h)
        |> filter(fn: (r) => r["_measurement"] == "request")
        |> filter(fn: (r) => r["jobId"] == "${jobId}")
        |> filter(fn: (r) => r["_field"] == "latency")
        |> yield(name: "raw_latencies")
    `;

    const latencies: number[] = [];

    queryApi.queryRows(fluxQuery, {
      next: (row, tableMeta) => {
        const o = tableMeta.toObject(row);
        latencies.push(o._value);
      },
      error: (error) => {
        console.error('Influx Query Error:', error);
        res.status(500).json({ error: 'Error fetching metrics' });
      },
      complete: () => {
        if (latencies.length === 0) {
          return res.json({ message: 'No metrics found for this job yet. (Wait for worker to flush)' });
        }
        
        // Calculate basic stats manually for now
        latencies.sort((a, b) => a - b);
        const sum = latencies.reduce((a, b) => a + b, 0);
        const avg = sum / latencies.length;
        const max = latencies[latencies.length - 1];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];

        res.json({
          totalRequests: latencies.length,
          avgLatencyMs: Math.round(avg),
          p95LatencyMs: Math.round(p95),
          maxLatencyMs: Math.round(max)
        });
      },
    });

  } catch (error) {
    res.status(500).json({ error: 'Server error querying metrics' });
  }
});

export default router;