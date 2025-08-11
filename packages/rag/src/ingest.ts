import 'dotenv/config';
import { Pool } from 'pg';
import { OpenAIEmbeddings } from '@langchain/openai';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Document } from 'langchain/document';
import { DirectoryLoader } from 'langchain/document_loaders/fs/directory';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { PDFLoader } from 'langchain/document_loaders/fs/pdf';

const DATA_DIR = new URL('../../../data/kb', import.meta.url).pathname;

async function loadDocs() {
  const loader = new DirectoryLoader(DATA_DIR, {
    '.md': (p: string) => new TextLoader(p),
    '.txt': (p: string) => new TextLoader(p),
    '.pdf': (p: string) => new PDFLoader(p), // requires pdf-parse
  });
  const docs = await loader.load();
  return docs;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  });

  // Ensure table exists and connect store
  const tableName = process.env.TABLE_NAME || 'docs';
  const store = await PGVectorStore.initialize(embeddings, { pool, tableName });

  const rawDocs = await loadDocs();
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 120,
  });
  const chunks: Document[] = [];
  for (const d of rawDocs) {
    const split = await splitter.splitDocuments([
      new Document({
        pageContent: d.pageContent,
        metadata: {
          source: d.metadata.source,
          type: d.metadata._pdf ? 'pdf' : 'text',
        },
      }),
    ]);
    // Attach a stable source_id for citations
    split.forEach((s, i) => (s.metadata.chunk = i));
    chunks.push(...split);
  }

  console.log(`Loaded ${rawDocs.length} files → ${chunks.length} chunks`);
  await store.addDocuments(chunks);
  console.log('Embeddings upserted into pgvector table:', tableName);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
