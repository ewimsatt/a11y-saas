import { QUEUES } from './queues';

console.log('Worker boot');
console.log('Queues:', Object.values(QUEUES).join(', '));
// TODO: register BullMQ processors for crawl/analyze/diff/evidence
