import { buildApp } from './http/app';

const app = buildApp();

await app.listen({ port: 3001, host: '127.0.0.1' });
