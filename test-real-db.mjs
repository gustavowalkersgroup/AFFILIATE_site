import pg from 'pg';

const client = new pg.Client({
  host: 'localhost',
  port: 5432,
  database: 'affiliate',
  user: 'affiliate',
  password: 'a4695f6cdadf78e421ca967043117ea0',
  connectionTimeoutMillis: 3000
});

try {
  await client.connect();
  console.log('✓ Conectado com sucesso');
  
  const result = await client.query(`
    SELECT 
      (SELECT count(*)::int FROM offers) as offers,
      (SELECT count(*)::int FROM posts) as posts,
      (SELECT count(*)::int FROM messages) as messages,
      (SELECT count(*)::int FROM broadcast_log) as broadcasts,
      (SELECT count(*)::int FROM jobs WHERE status='pending') as pending_jobs,
      (SELECT count(*)::int FROM conversations) as conversations
  `);
  
  const data = result.rows[0];
  console.log('\n📊 DADOS DO BANCO');
  console.log(`Ofertas: ${data.offers}`);
  console.log(`Posts: ${data.posts}`);
  console.log(`Mensagens: ${data.messages}`);
  console.log(`Broadcasts: ${data.broadcasts}`);
  console.log(`Jobs pendentes: ${data.pending_jobs}`);
  console.log(`Conversas: ${data.conversations}`);
  
  await client.end();
} catch (e) {
  console.error(`✗ Erro: ${e.message}`);
  process.exit(1);
}
