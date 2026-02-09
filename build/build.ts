import path from 'node:path';
import fs from 'node:fs/promises';
import ejs from 'ejs';

const BITS_JSON = './bits.json';
const DIST_DIR = './dist';

const wrapPromise = <T,>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));

const directoryExists = (path: string) =>
  fs.lstat(path).then(dir => dir.isDirectory()).catch(() => false)

const createPromisePool = async <T,>(
  generator: Generator<Promise<T>, void>,
  concurrency = 5
) => {
  const output: PromiseSettledResult<T>[] = [];
  const worker = async () => {
    for (const promise of generator) {
      output.push(await wrapPromise(promise));
    }
  };

  await Promise.all(Array.from({ length: concurrency }).map(worker));
  return output;
};

const resolveUri = (uri: string) => {
  if (uri.startsWith('github:')) {
    const [user, repo, branch, ...path] = uri.replace(/^github:/, '').split('/');
    return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path.join('/')}`;
  }

  if (uri.startsWith('gist:')) {
    const [user, gistId, filename] = uri.replace(/^gist:/, '').split('/');
    return `https://gist.githubusercontent.com/${user}/${gistId}/raw/${filename}`;
  }
  return uri;
};


type BitsJSON = Record<string, {
  name: string;
  description: string;
  uri: string;
}>

const build = async () => {
  console.log("Starting Build...");

  await fs.rm(DIST_DIR, { recursive: true }).catch(() => {});
  await fs.mkdir(DIST_DIR, { recursive: true });

  if (await directoryExists('./images')) {
    await fs.cp('./images', path.join(DIST_DIR, 'images'), { recursive: true });
  }

  const bits = JSON.parse(await fs.readFile(BITS_JSON, 'utf8')) as BitsJSON;
  const results = await createPromisePool(function* () {
    for (const [id, bit] of Object.entries(bits)) {
      yield (async () => {
        const url = resolveUri(bit.uri);
        console.log(`Downloading ${id} from ${url}...`);

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
        const htmlContent = await res.text();

        const bitDir = path.join(DIST_DIR, id);
        await fs.mkdir(bitDir, { recursive: true });
        await fs.writeFile(path.join(bitDir, 'index.html'), htmlContent);
        return id;
      })();
    }
  }(), 32);

  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      console.error(`Failed to process ${Object.keys(bits)[idx]}:`, result.reason);
    }
  });

  console.log("Rendering Index Page...");
  const templatePath = path.join(import.meta.dirname, 'index.ejs');
  const indexHtml = await ejs.renderFile(templatePath, { bits });
  await fs.writeFile(path.join(DIST_DIR, 'index.html'), indexHtml);

  console.log("Build Complete!");
}

build();
