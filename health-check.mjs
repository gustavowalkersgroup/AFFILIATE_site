import pg from 'pg';
import fs from 'fs';

// Tentar ler .pgpass se existir
const credenciais = [
  { user: 'postgres', password: 'postgres', desc: 'postgres:postgres' },
  { user: 'postgres', password: '', desc: 'postgres (sem senha)' },
  { user: 'affiliate', password: 'affiliate', desc: 'affiliate:affiliate' },
];

for (const cred of credenciais) {
  const client = new pg.Client({
    host: 'localhost',
    port: 5432,
    database: 'affiliate',
    user: cred.user,
    password: cred.password,
    connectionTimeoutMillis: 3000
  });
  
  try {
    await client.connect();
    console.log(`✓ Conectado como ${cred.desc}`);
    
    const result = await client.query(`
      SELECT 
        (SELECT count(*) FROM offers) as offers,
        (SELECT count(*) FROM posts) as posts,
        (SELECT count(*) FROM messages) as messages,
        (SELECT count(*) FROM broadcast_log) as broadcasts,
        (SELECT count(*) FROM jobs WHERE status='pending') as pending_jobs
    `);
    
    const data = result.rows[0];
    console.log('\nOfertas:', data.offers);
    console.log('Posts:', data.posts);
    console.log('Mensagens:', data.messages);
    console.log('Broadcasts:', data.broadcasts);
    console.log('Jobs pendentes:', data.pending_jobs);
    
    await client.end();
    break;
  } catch (e) {
    console.log(`✗ ${cred.desc}: ${e.message.split('\n')[0]}`);
    await client.end().catch(()=>{});
  }
}
