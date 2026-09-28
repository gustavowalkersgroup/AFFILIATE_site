import pg from 'pg';

const creds = [
  { user: 'postgres', password: 'postgres', db: 'affiliate' },
  { user: 'postgres', password: '', db: 'postgres' },
];

for (const c of creds) {
  try {
    const client = new pg.Client({
      host: 'localhost',
      port: 5432,
      database: c.db,
      user: c.user,
      password: c.password,
      connectionTimeoutMillis: 2000
    });
    await client.connect();
    console.log(`✓ ${c.user}@${c.db}`);
    
    const res = await client.query(`SELECT version();`);
    console.log(`  Version: ${res.rows[0].version.split(',')[0]}`);
    
    await client.end();
    break;
  } catch(e) {
    console.log(`✗ ${c.user}@${c.db}: ${e.code || e.message}`);
  }
}
