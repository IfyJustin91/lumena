import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, '..', 'benchmark-results.json');

const app = express();
const PORT = process.env.PORT || 3456;

// Serve the HTML viewer
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// API endpoint that returns the latest benchmark results
app.get('/api/results', (_req, res) => {
  if (!existsSync(RESULTS_PATH)) {
    return res.status(404).json({
      error: 'benchmark-results.json not found. Run: cargo run --package benchmarks --bin benchmarks',
    });
  }
  try {
    const raw = readFileSync(RESULTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Failed to parse results: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n🔭  Benchmark Viewer running at http://localhost:${PORT}\n`);
  if (!existsSync(RESULTS_PATH)) {
    console.log(
      '⚠️  No benchmark-results.json found yet.\n' +
      '   Run the suite first:\n' +
      '     cargo run --package benchmarks --bin benchmarks\n'
    );
  }
});
