require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const fetch = require('node-fetch');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env file.');
  process.exit(1);
}

async function getEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

async function promptOverwrite(filename) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(`File ${filename} already exists. Overwrite? (y/N): `, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node embed-rules.cjs <rules-json-filename>');
    process.exit(1);
  }
  const inputPath = path.isAbsolute(inputFile) ? inputFile : path.join(process.cwd(), inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const outputFile = `${baseName}-embeddings.json`;
  const outputDir = path.dirname(inputPath);
  const outputPath = path.join(outputDir, outputFile);
  if (fs.existsSync(outputPath)) {
    const ok = await promptOverwrite(outputFile);
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }
  const rules = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  if (!Array.isArray(rules)) {
    console.error('Input JSON must be an array of rule objects.');
    process.exit(1);
  }
  const results = [];
  for (const rule of rules) {
    const inputText = `${rule.title || ''}\n${rule.text || ''}`.trim();
    if (!inputText) {
      results.push({ ...rule, embedding: null });
      continue;
    }
    process.stdout.write(`Embedding rule ${rule.id || ''}... `);
    try {
      const embedding = await getEmbedding(inputText);
      results.push({ ...rule, embedding });
      console.log('done.');
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      results.push({ ...rule, embedding: null, error: err.message });
    }
  }
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`Embeddings written to ${outputPath}`);
}

main(); 