import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const server = createServer({
    port: 3000,
    base: join(HERE, 'src'),
});

const { url } = await server.connect();

console.log(`Server is running at ${url}`);
