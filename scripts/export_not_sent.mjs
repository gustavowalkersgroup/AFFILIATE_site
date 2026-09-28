import { pool } from '../src/db.js';
import fs from 'node:fs';

async function exportNotSent() {
  try {
    console.log('Consultando contatos que NÃO receberam disparo...');

    // Pega pending (ainda na fila) e failed (tentou mas falhou)
    const { rows } = await pool.query(
      `SELECT name, phone, status, last_error
       FROM contacts
       WHERE status IN ('pending', 'failed')
       ORDER BY status, name ASC`
    );

    if (rows.length === 0) {
      console.log('Nenhum contato pendente ou com falha encontrado.');
      return;
    }

    const header = 'Nome,Telefone,Status,Erro\n';
    const csvContent = rows.map(r => {
      const name = (r.name || '').replace(/"/g, '""');
      const phone = (r.phone || '').replace(/"/g, '""');
      const status = (r.status || '').replace(/"/g, '""');
      const error = (r.last_error || '').replace(/"/g, '""');
      return `"${name}","${phone}","${status}","${error}"`;
    }).join('\n');

    const fileName = `contatos_nao_receberam_${new Date().toISOString().split('T')[0]}.csv`;
    fs.writeFileSync(fileName, header + csvContent, 'utf8');

    console.log(`Sucesso! ${rows.length} contatos exportados para: ${fileName}`);
  } catch (err) {
    console.error('Erro ao exportar:', err.message);
  } finally {
    await pool.end();
  }
}

exportNotSent();
