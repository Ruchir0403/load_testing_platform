import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { InfluxDB } from '@influxdata/influxdb-client';
import scenarioRoutes from './routes/scenarios';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Serve the HTML dashboard
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api/scenarios', scenarioRoutes);

// Setup InfluxDB for Live Polling
const influx = new InfluxDB({ url: 'http://localhost:8086', token: 'supersecrettoken123' });
const queryApi = influx.getQueryApi('loadtest');

io.on('connection', (socket) => {
  console.log('[API] UI Dashboard Connected');
});

// The Broadcast Loop (Runs every 2 seconds)
setInterval(() => {
  // Query only the last 5 seconds of data to keep it highly real-time
  const fluxQuery = `
    from(bucket: "metrics")
      |> range(start: -5s)
      |> filter(fn: (r) => r["_measurement"] == "request")
      |> filter(fn: (r) => r["_field"] == "latency")
      |> yield(name: "live_latencies")
  `;

  const latencies: number[] = [];
  queryApi.queryRows(fluxQuery, {
    // next: (row, tableMeta) => latencies.push(tableMeta.toObject(row)._value),
    next: (row, tableMeta) => { latencies.push(tableMeta.toObject(row)._value); },
    error: (err) => console.error(err),
    complete: () => {
      if (latencies.length > 0) {
        latencies.sort((a, b) => a - b);
        const sum = latencies.reduce((a, b) => a + b, 0);
        
        io.emit('live-metrics', {
          rps: Math.round(latencies.length / 5), // Requests / 5 seconds
          avgLatency: Math.round(sum / latencies.length),
          p95Latency: Math.round(latencies[Math.floor(latencies.length * 0.95)]),
          timestamp: new Date().toLocaleTimeString()
        });
      }
    }
  });
}, 2000);

server.listen(PORT, () => {
  console.log(`[Control Plane API] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard] View live metrics at http://localhost:${PORT}/index.html`);
});