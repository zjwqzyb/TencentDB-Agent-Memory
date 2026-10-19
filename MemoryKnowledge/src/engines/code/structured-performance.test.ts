/** Repeatable backend-only benchmark. Browser latency is measured separately by final QA. */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, cpus, totalmem, platform, release, arch, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { queryStructured, type StructuredContext } from './structured.js';
import type { CodeGraphRequest } from '../../contracts/code-graph.js';

describe('5,000-node / 15,000-edge bounded-query performance',()=>{
  it('keeps 30 warmed queries per mode within the 2s p95 target and actual work budgets',()=>{
    const root=mkdtempSync(join(tmpdir(),'cg-perf-'));
    try {
      const databasePath=join(root,'index.db'); const db=new Database(databasePath);
      db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER);
        CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER);
        CREATE INDEX idx_edges_source_kind ON edges(source,kind); CREATE INDEX idx_edges_target_kind ON edges(target,kind);
        CREATE TABLE files(path TEXT PRIMARY KEY,content_hash TEXT);
        CREATE TABLE unresolved_refs(id INTEGER PRIMARY KEY,from_node_id TEXT,reference_name TEXT,reference_kind TEXT,file_path TEXT,line INTEGER,col INTEGER);
        CREATE INDEX idx_unresolved_from_node ON unresolved_refs(from_node_id);`);
      const n=db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,1,5)'), e=db.prepare('INSERT INTO edges VALUES (?,?,?,?,2,0)');
      db.transaction(()=>{
        for(let i=0;i<5000;i++)n.run(`n${i}`,i<3000?'function':i<4000?'class':'interface',`n${i}`,`mod${i%10}.n${i}`,`mod${i%10}/f${i}.ts`,'typescript');
        let serial=1;
        for(let i=0;i<300;i++)e.run(serial++,'n0',`n${i%99+1}`,'calls');
        for(let i=0;i<8700;i++)e.run(serial++,`n${i%3000}`,`n${(i%3000+Math.floor(i/3000)+1)%3000}`,'calls');
        for(let i=0;i<3000;i++)e.run(serial++,`n${i}`,`n${(i+17)%3000}`,'imports');
        for(let i=0;i<1000;i++){e.run(serial++,`n${3000+i}`,`n${3000+(i+1)%1000}`,'extends');e.run(serial++,`n${3000+i}`,`n${4000+i}`,'implements');e.run(serial++,`n${3000+i}`,`n${4000+(i+1)%1000}`,'implements');}
        const file = db.prepare('INSERT INTO files VALUES (?,?)');
        for (let i=0;i<3000;i++) {
          const path = `mod${i%10}/f${i}.ts`, target=(i+17)%3000;
          const source = `// benchmark source\nimport { n${target} } from '../mod${target%10}/f${target}';\n`;
          mkdirSync(dirname(join(root,path)),{recursive:true}); writeFileSync(join(root,path),source);
          file.run(path,createHash('sha256').update(source).digest('hex'));
        }
      })();
      expect((db.prepare('SELECT COUNT(*) n FROM nodes').get() as {n:number}).n).toBe(5000);
      expect((db.prepare('SELECT COUNT(*) n FROM edges').get() as {n:number}).n).toBe(15000);db.close();
      const ctx:StructuredContext={assetId:'cg-perf',projectRoot:root,databasePath,sdkVersion:'1.6.2',version:1,commit:null,indexedAt:'fixture',branch:'main'};
      const snapshot=queryStructured(ctx,'graph-search',{}).indexVersion!;
      const report:Record<string,unknown>={generatedAt:new Date().toISOString(),hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),os:`${platform()} ${release()} ${arch()}`,node:process.version},hostLoad:{startLoad1m5m15m:loadavg(),isolation:'local development host, no CPU or filesystem isolation'},fixture:{nodes:5000,edges:15000,kind:'synthetic SQLite topology; not parser coverage'},browser:'not applicable: backend measurement',measurement:'queryStructured read-only connection + schema validation + bounded SQL + response object construction; excludes JSON encoding, HTTP transport and rendering',coldDefinition:'first query of the mode in this process, OS page cache not flushed; 5 warmups then 30 raw samples'};
      for(const mode of ['calls','impact','hierarchy','dependencies','clusters'] as const){
        const aggregate=mode==='dependencies'||mode==='clusters';
        let query:CodeGraphRequest={mode,...(aggregate ? {} : { nodeId:`cg-perf@${snapshot}:n${mode==='hierarchy'?3000:0}` }),indexVersion:snapshot,limit:100,edgeLimit:300};
        const coldStarted=performance.now(), cold=queryStructured(ctx,'graph',query), coldMs=performance.now()-coldStarted;
        let phaseFirstMs: number | undefined;
        if (aggregate) {
          let response=cold, pages=1;
          // Move past the node-only and non-import scan windows; measure an actual
          // import-aggregation continuation repeatedly, with immutable cursor state.
          while ((response.aggregation?.scannedEdges ?? 0) < 9000) {
            expect(response.nextCursor).toBeTruthy(); expect(++pages).toBeLessThan(30);
            response=queryStructured(ctx,'graph',{...query,cursor:response.nextCursor!});
          }
          expect(response.nextCursor).toBeTruthy(); query={...query,cursor:response.nextCursor!};
          const started=performance.now(), next=queryStructured(ctx,'graph',query); phaseFirstMs=performance.now()-started;
          expect(next.aggregation!.scannedEdges).toBeGreaterThan(response.aggregation!.scannedEdges);
          expect(next.edges.reduce((sum,edge)=>sum+(edge.count??0),0)).toBeGreaterThan(response.edges.reduce((sum,edge)=>sum+(edge.count??0),0));
        }
        if (mode === 'calls') {
          expect(cold.nodes).toHaveLength(100); expect(cold.edges).toHaveLength(300);
          if(process.env.CODEGRAPH_BENCHMARK_DATASET)writeFileSync(process.env.CODEGRAPH_BENCHMARK_DATASET,JSON.stringify(cold,null,2));
        }
        for(let i=0;i<5;i++)queryStructured(ctx,'graph',query);
        const samples:number[]=[];let maxRows=0;
        for(let i=0;i<30;i++){const started=performance.now();const response=queryStructured(ctx,'graph',query);samples.push(performance.now()-started);maxRows=Math.max(maxRows,response.work!.rowsRead);expect(response.nodes.length).toBeLessThanOrEqual(100);expect(response.edges.length).toBeLessThanOrEqual(300);expect(response.work!.rowsRead).toBeLessThanOrEqual(2000);}
        const sorted=[...samples].sort((a,b)=>a-b);const p95=sorted[Math.ceil(sorted.length*0.95)-1];expect(p95).toBeLessThanOrEqual(2000);
        report[mode]={coldMs,phase:aggregate?'import edges continuation':'initial neighborhood',phaseFirstMs,rawSamplesMs:samples,samples:samples.length,p50ms:sorted[14],p95ms:p95,maxMs:sorted.at(-1),maxRows};
      }
      (report.hostLoad as Record<string,unknown>).endLoad1m5m15m=loadavg();
      console.log('CODEGRAPH_BACKEND_BENCHMARK '+JSON.stringify(report));
      if (process.env.CODEGRAPH_BENCHMARK_REPORT) writeFileSync(process.env.CODEGRAPH_BENCHMARK_REPORT, JSON.stringify(report, null, 2));
    } finally {rmSync(root,{recursive:true,force:true});}
  }, 120_000);
});
