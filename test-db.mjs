import pg from 'pg';
import { config } from 'dotenv';

config();

const client = new pg.Client(process.env.DATABASE_URL);

try {
  await client.connect();
  console.log('✓ Conectado ao banco de dados');
  
  const result = await client.query(`
    SELECT 
      (SELECT count(*) FROM offers) as offers,
      (SELECT count(*) FROM posts) as posts,
      (SELECT count(*) FROM messages) as messages,
      (SELECT count(*) FROM broadcast_log) as broadcasts,
      (SELECT count(*) FROM jobs WHERE status='pending') as pending_jobs,
      (SELECT count(*) FROM conversations) as conversations
  `);
  
  const data = result.rows[0];
  console.log('\nOferta:', data.offers);
  console.log('Posts:', data.posts);
  console.log('Mensagens:', data.messages);
  console.log('Broadcasts:', data.broadcasts);
  console.log('Jobs pendentes:', data.pending_jobs);
  console.log('Conversas:', data.conversations);
  
  await client.end();
} catch (e) {
  console.log('✗ Erro:', e.message);
  process.exit(1);
}
