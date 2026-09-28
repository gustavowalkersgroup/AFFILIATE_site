require('dotenv').config();
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const cols = async (t)=>{
    const r=await p.query("select column_name,data_type from information_schema.columns where table_name=$1 order by ordinal_position",[t]);
    console.log(t+':', r.rows.map(c=>c.column_name+':'+c.data_type).join(', '));
  };
  for (const t of ['messages','posts','slots','warmer_log','groups','contacts','offers','keywords','settings']) {
    await cols(t);
  }
  process.exit(0);
})();
