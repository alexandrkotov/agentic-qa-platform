import express from 'express';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemDescriptorSchema } from '../descriptor/schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESCRIPTORS_DIR = resolve(__dirname, '../../descriptors');
const PORT = Number(process.env.ADMIN_PORT ?? 4400);

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Resolves a descriptor name to a file path, rejecting anything that isn't a
 * plain filename component — this is the only thing standing between an HTTP
 * request body and a path on disk, so it must reject traversal outright
 * rather than merely warn. */
function descriptorPath(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('Descriptor name must be alphanumeric (with - or _ only)'), {
      status: 400,
    });
  }
  return join(DESCRIPTORS_DIR, `${name}.json`);
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'static')));

app.get('/api/descriptors', async (_req, res) => {
  const files = await readdir(DESCRIPTORS_DIR);
  const names = files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  res.json(names);
});

app.get('/api/descriptors/:name', async (req, res) => {
  try {
    const raw = await readFile(descriptorPath(req.params.name), 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: `No descriptor named "${req.params.name}"` });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.put('/api/descriptors/:name', async (req, res) => {
  try {
    const path = descriptorPath(req.params.name);
    const parsed = SystemDescriptorSchema.parse(req.body);
    await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    res.json(parsed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.post('/api/descriptors', async (req, res) => {
  try {
    const { name, ...body } = req.body as { name?: string };
    if (!name) {
      res.status(400).json({ error: '"name" is required' });
      return;
    }
    const path = descriptorPath(name);
    try {
      await readFile(path, 'utf-8');
      res.status(409).json({ error: `Descriptor "${name}" already exists` });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parsed = SystemDescriptorSchema.parse({ name, components: [], ...body });
    await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    res.status(201).json(parsed);
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err) {
      res.status(400).json({ error: 'Validation failed', issues: (err as { issues: unknown }).issues });
      return;
    }
    res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[admin] Descriptor editor: http://localhost:${PORT}`);
  console.log(`[admin] Serving descriptors from ${DESCRIPTORS_DIR}`);
});
