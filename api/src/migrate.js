export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/apply-migrations' && request.method === 'POST') {
      try {
        // Read the migration SQL from the request body
        const { sql } = await request.json();
        
        // Execute via Supabase client
        const supabase = new SupabaseClient(
          'https://xsgvdlgmhuxozjlbjzxy.supabase.co',
          env.SUPABASE_SERVICE_KEY,
          { auth: { autoRefreshToken: false, persistSession: false } }
        );
        
        // First create the helper function
        await supabase.rpc('exec_sql', { 
          sql_text: `
            CREATE OR REPLACE FUNCTION exec_sql(sql_text text) 
            RETURNS text AS $$
            DECLARE result text;
            BEGIN 
                EXECUTE sql_text; 
                RETURN 'OK'; 
            END;
            $$ LANGUAGE plpgsql;
          `
        });
        
        // Split and execute all statements
        const statements = sql.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
        const results = [];
        
        for (const stmt of statements) {
          try {
            await supabase.rpc('exec_sql', { sql_text: stmt.trim() });
            results.push({ status: 'ok' });
          } catch (e) {
            results.push({ status: 'error', error: e.message });
          }
        }
        
        return new JSON.stringify({ 
          success: true, 
          executed: results.length,
          results 
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response('Turbo Creator Migration API', { status: 200 });
  }
};
