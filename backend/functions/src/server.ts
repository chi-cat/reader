import 'reflect-metadata';
import express from 'express';
import { container } from 'tsyringe';
import { CrawlerHost } from './cloud-functions/crawler';
import path from 'path';
import { SearXNGSearchHost } from './cloud-functions/searxng-searcher';

const app = express();
const port = process.env.PORT || 3000;

const crawlerHost = container.resolve(CrawlerHost);
const searXNGSearchHost = container.resolve(SearXNGSearchHost)

app.use(express.json());

// Serve static files from the local-storage directory
app.use('/instant-screenshots', express.static(path.join('/app', 'local-storage', 'instant-screenshots')));

// Handle favicon requests with 404
app.get('/favicon.ico', (req, res) => {
  res.status(404).end();
});
app.all('/s/*', async (req, res) => {
  try {
    await searXNGSearchHost.search(req, res);
  } catch (error: any) {
    console.error('Error during crawl:', error);

    // Kontrola typu chyby
    if (error.message.includes('Invalid TLD')) {
      res.status(400).json({ error: 'Invalid URL or TLD' });
    } else {
      // Ošetrenie iných chýb
      res.status(500).json({ error: 'An error occurred during the crawl' });
    }
  }
})
app.all('*', async (req, res) => {
  try {
    await crawlerHost.crawl(req, res);
  } catch (error: any) {
    console.error('Error during crawl:', error);

    // Kontrola typu chyby
    if (error.message.includes('Invalid TLD')) {
      res.status(400).json({ error: 'Invalid URL or TLD' });
    } else {
      // Ošetrenie iných chýb
      res.status(500).json({ error: 'An error occurred during the crawl' });
    }
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export default app;
